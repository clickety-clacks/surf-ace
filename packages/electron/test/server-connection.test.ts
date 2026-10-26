import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { ServerConnection } from "../src/server-connection.js";
import { ConfiguredServerRegistration } from "../src/configured-server.js";
import { SurfaceCore } from "../src/surface-core.js";
import { createEmptyLocklessClientState, DEFAULT_LOCKLESS_LIMITS } from "../src/lockless-client-authority.js";
import {
  loadPersistentStateFile,
  persistentStateSelectorFileName,
  writePersistentStateFile,
} from "../src/persistent-state-file.js";

test("Bonjour transport address avoids slow hostname resolution and retains hostname fallback", async () => {
  const originalIdentity = ConfiguredServerRegistration.prototype.readRegistryIdentity;
  const original = ConfiguredServerRegistration.prototype.synchronize;
  const originalStop = ConfiguredServerRegistration.prototype.stop;
  try {
    for (const code of [undefined, "ECONNREFUSED", "registration_failed"]) {
      const attempted: string[] = [];
      ConfiguredServerRegistration.prototype.readRegistryIdentity = async function () {
        const url = (this as any).wire.url as string;
        attempted.push(url);
        if (url.includes("192.0.2.10") && code) throw Object.assign(new Error(code), { code });
        return { allocatorId: "alloc_fixture", fleetId: "fixture-fleet" };
      };
      ConfiguredServerRegistration.prototype.synchronize = async function () {
        return;
      };
      ConfiguredServerRegistration.prototype.stop = async () => {};
      const endpoint = {
        host: "stable.local", endpointId: "stable.local:19430/ws#stable", port: 19430,
        wsPath: "/ws", protocolVersion: 1, role: "server", transportAddresses: ["192.0.2.10"],
      } as any;
      const connection = new ServerConnection({
        clientId: "fixture", core: new SurfaceCore(), persist: async () => {},
        discovery: {
          start: async () => {}, stop: async () => {}, refreshNow: async () => {},
          subscribe: () => () => {}, getSnapshot: () => [endpoint],
        },
      });
      await connection.synchronize();
      assert.deepEqual(attempted, code
        ? ["ws://192.0.2.10:19430/ws", "ws://stable.local:19430/ws"]
        : ["ws://192.0.2.10:19430/ws"]);
      assert.equal(endpoint.host, "stable.local");
      assert.equal(endpoint.endpointId, "stable.local:19430/ws#stable");
      await connection.stop();
    }
  } finally {
    ConfiguredServerRegistration.prototype.synchronize = original;
    ConfiguredServerRegistration.prototype.stop = originalStop;
    ConfiguredServerRegistration.prototype.readRegistryIdentity = originalIdentity;
  }
});

test("a former registry stays behind the current binding but becomes eligible after it disappears", async () => {
  const clientId = "b".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  core.ensurePrimarySurface("Former registry selection", { width: 800, height: 600, scale: 1 });
  const former = { allocatorId: "alloc_former", fleetId: "fleet-former" };
  const current = { allocatorId: "alloc_current", fleetId: "fleet-current" };
  core.bindRegistryIdentity({ clientId, ...current });
  const oldReadIdentity = ConfiguredServerRegistration.prototype.readRegistryIdentity;
  const oldSynchronize = ConfiguredServerRegistration.prototype.synchronize;
  const oldStop = ConfiguredServerRegistration.prototype.stop;
  const adopted: string[] = [];
  const identities = new Map([
    ["ws://former.registry.test:19001/ws", former],
    ["ws://current.registry.test:19002/ws", current],
  ]);
  try {
    ConfiguredServerRegistration.prototype.readRegistryIdentity = async function () {
      return identities.get((this as any).wire.url) as typeof former;
    };
    ConfiguredServerRegistration.prototype.synchronize = async function (options = {}) {
      const identity = identities.get((this as any).wire.url)!;
      const binding = core.registryBinding();
      if (binding && (binding.allocatorId !== identity.allocatorId || binding.fleetId !== identity.fleetId) &&
          options.allowRebind !== true) throw new Error("foreign_registry_identity");
      if (!binding || binding.allocatorId !== identity.allocatorId || binding.fleetId !== identity.fleetId) {
        core.beginRegistryBinding({ clientId, ...identity });
        core.completeRegistryBinding();
      }
      adopted.push(identity.allocatorId);
    };
    ConfiguredServerRegistration.prototype.stop = async () => {};

    const formerEndpoint = {
      host: "former.registry.test", port: 19001, wsPath: "/ws", protocolVersion: 1, role: "server", instanceName: "Former",
    } as any;
    const currentEndpoint = {
      host: "current.registry.test", port: 19002, wsPath: "/ws", protocolVersion: 1, role: "server", instanceName: "Current",
    } as any;
    const discovery = emptyDiscovery();
    discovery.getSnapshot = () => [formerEndpoint, currentEndpoint];
    const preferred = new ServerConnection({
      clientId, core, persist: async () => {}, discovery, requestTimeoutMs: 100, registryRebindWaitMs: 0,
    });
    await preferred.synchronize();
    assert.deepEqual(adopted, ["alloc_current"]);
    assert.deepEqual(core.registryBinding(), { clientId, ...current });
    await preferred.stop();

    discovery.getSnapshot = () => [formerEndpoint];
    const fallback = new ServerConnection({
      clientId, core, persist: async () => {}, discovery, requestTimeoutMs: 100, registryRebindWaitMs: 0,
    });
    await fallback.synchronize();
    assert.deepEqual(adopted, ["alloc_current", "alloc_former"]);
    assert.deepEqual(core.registryBinding(), { clientId, ...former });
    await fallback.stop();
  } finally {
    ConfiguredServerRegistration.prototype.readRegistryIdentity = oldReadIdentity;
    ConfiguredServerRegistration.prototype.synchronize = oldSynchronize;
    ConfiguredServerRegistration.prototype.stop = oldStop;
  }
});


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "lifecycle condition reached");
}

function emptyDiscovery() {
  return {
    start: async () => {}, stop: async () => {}, refreshNow: async () => {},
    subscribe: () => () => {}, getSnapshot: (): any[] => [],
  };
}

async function centralFixture(
  registryIdentity: { allocatorId: string; fleetId: string } | null =
    { allocatorId: "alloc_fixture", fleetId: "fixture-fleet" },
  options: { deferIdentityReplies?: boolean } = {},
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const requests: Array<{ socket: WebSocket; message: any }> = [];
  const identityRequests: Array<{ socket: WebSocket; message: any }> = [];
  const replyIdentity = (index: number): void => {
    const { socket, message } = identityRequests[index]!;
    socket.send(JSON.stringify({
      type: "response", v: 1, id: message.id, op: message.op, ok: true,
      payload: registryIdentity ? { registryIdentity } : {},
    }));
  };
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.op === "fleet.topology") {
        identityRequests.push({ socket, message });
        if (!options.deferIdentityReplies) replyIdentity(identityRequests.length - 1);
      } else {
        requests.push({ socket, message });
      }
    });
  });
  return {
    server, requests, identityRequests, replyIdentity, port, address: `ws://127.0.0.1:${port}/`,
    reply(index: number, ok = true, assignPaneLabels = true, paneLabelBase = 700, windowLabel?: string,
      responseIdentity: { allocatorId: string; fleetId: string } | null = registryIdentity,
      responseOptions: { windowGenerationV1?: boolean; completedWindowReleaseIds?: string[] } = { windowGenerationV1: true }) {
      const { socket, message } = requests[index]!;
      assert.equal(message.op, "client.register");
      socket.send(JSON.stringify({
        type: "response", v: 1, id: message.id, op: message.op, ok,
        payload: { clientId: message.payload.clientId,
          ...(responseIdentity ? { registryIdentity: responseIdentity } : {}),
          ...(responseOptions.windowGenerationV1 === undefined
            ? {} : { windowGenerationV1: responseOptions.windowGenerationV1 }),
          completedPaneReleaseIds: (message.payload.pendingPaneReleases ?? []).map((release: any) => release.releaseId),
          ...(responseOptions.windowGenerationV1 === true ? {
            completedWindowReleaseIds: responseOptions.completedWindowReleaseIds ??
              (message.payload.pendingWindowReleases ?? []).map((release: any) => release.releaseId),
          } : {}),
          surfaces: message.payload.surfaces.map((surface: any, i: number) => ({
            surfaceId: surface.surfaceId,
            windowLabel: windowLabel ?? String.fromCharCode(97 + i),
            ...(responseOptions.windowGenerationV1 === true ? {
              windowGeneration: Number.isSafeInteger(surface.windowGeneration) && surface.windowGeneration > 0
                ? surface.windowGeneration : i + 1,
            } : {}),
            ...(assignPaneLabels ? {
              panes: (surface.panes ?? []).map((pane: any, paneIndex: number) => ({
                ...pane,
                allocationGeneration: pane.allocationGeneration ?? paneLabelBase + i * 100 + paneIndex,
                paneLabel: paneLabelBase + i * 100 + paneIndex,
              })),
            } : {}),
          })) },
        ...(!ok ? { error: { message: "registration_rejected" } } : {}),
      }));
    },
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function automaticRegistryFixture(options: {
  identity?: { allocatorId: string; fleetId: string } | null;
  rejectClaim?: (payload: any) => boolean;
  rejectReleaseIds?: Set<string>;
  rejectRegistration?: () => boolean;
  seed?: Array<{ surfaceId: string; windowLabel: string; windowGeneration: number;
    panes: Array<{ paneId: string; paneLineageId: string; paneLabel: number; allocationGeneration: number }> }>;
} = {}) {
  const registryIdentity = options.identity === undefined
    ? { allocatorId: "alloc_fixture", fleetId: "fixture-fleet" } : options.identity;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const requests: Array<{ socket: WebSocket; message: any }> = [];
  const identityRequests: Array<{ socket: WebSocket; message: any }> = [];
  const windows = new Map<string, { windowGeneration: number; windowLabel: string }>();
  const panes = new Map<string, { allocationGeneration: number; paneLabel: number }>();
  let nextGeneration = 1;
  for (const surface of options.seed ?? []) {
    windows.set(surface.surfaceId, { windowGeneration: surface.windowGeneration, windowLabel: surface.windowLabel });
    nextGeneration = Math.max(nextGeneration, surface.windowGeneration + 1);
    for (const pane of surface.panes) {
      panes.set(`${surface.surfaceId}\0${pane.paneId}\0${pane.paneLineageId}`, {
        allocationGeneration: pane.allocationGeneration, paneLabel: pane.paneLabel,
      });
      nextGeneration = Math.max(nextGeneration, pane.allocationGeneration + 1);
    }
  }
  let nextWindowIndex = 0;
  let nextPaneLabel = 700;
  const completedPaneReleaseIds = new Set<string>();
  const completedWindowReleaseIds = new Set<string>();
  const releasedWindowLabels: string[] = [];
  const releasedPaneLabels: number[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.op === "fleet.topology") {
        identityRequests.push({ socket, message });
        socket.send(JSON.stringify({
          type: "response", v: 1, id: message.id, op: message.op, ok: true,
          payload: registryIdentity ? { registryIdentity } : {},
        }));
        return;
      }
      requests.push({ socket, message });
      const payload = message.payload;
      if (options.rejectRegistration?.()) {
        socket.send(JSON.stringify({
          type: "response", v: 1, id: message.id, op: message.op, ok: false,
          error: { code: "registration_failed", message: "registration_condition" },
        }));
        return;
      }
      const rejectedReleaseIds = options.rejectReleaseIds ?? new Set<string>();
      for (const release of payload.pendingPaneReleases ?? []) {
        if (rejectedReleaseIds.has(release.releaseId)) {
          socket.send(JSON.stringify({
            type: "response", v: 1, id: message.id, op: message.op, ok: false,
            error: { code: "registration_failed", message: "release_refused" },
          }));
          return;
        }
        const key = `${release.surfaceId}\0${release.paneId}\0${release.lineageId}`;
        const allocated = panes.get(key);
        if (allocated && allocated.paneLabel === release.paneLabel &&
            allocated.allocationGeneration === release.allocationGeneration) {
          panes.delete(key);
          releasedPaneLabels.push(allocated.paneLabel);
        }
        completedPaneReleaseIds.add(release.releaseId);
      }
      for (const release of payload.pendingWindowReleases ?? []) {
        if (rejectedReleaseIds.has(release.releaseId)) {
          socket.send(JSON.stringify({
            type: "response", v: 1, id: message.id, op: message.op, ok: false,
            error: { code: "registration_failed", message: "release_refused" },
          }));
          return;
        }
        const allocated = windows.get(release.surfaceId);
        if (allocated && allocated.windowLabel === release.windowLabel &&
            allocated.windowGeneration === release.windowGeneration) {
          windows.delete(release.surfaceId);
          releasedWindowLabels.push(allocated.windowLabel);
        }
        completedWindowReleaseIds.add(release.releaseId);
      }
      if (options.rejectClaim?.(payload)) {
        socket.send(JSON.stringify({
          type: "response", v: 1, id: message.id, op: message.op, ok: false,
          error: { code: "registration_failed", message: "claim_refused" },
        }));
        return;
      }
      const surfaces = payload.surfaces.map((surface: any) => {
        let window = windows.get(surface.surfaceId);
        if (!window) {
          let windowLabel = releasedWindowLabels.shift();
          if (!windowLabel) {
            const used = new Set([...windows.values()].map((entry) => entry.windowLabel));
            for (;;) {
              const candidate = String.fromCharCode(97 + nextWindowIndex++);
              if (!used.has(candidate)) { windowLabel = candidate; break; }
            }
          }
          window = {
            windowGeneration: Number.isSafeInteger(surface.windowGeneration) && surface.windowGeneration > 0
              ? surface.windowGeneration : nextGeneration++,
            windowLabel,
          };
          windows.set(surface.surfaceId, window);
        }
        return {
          surfaceId: surface.surfaceId,
          windowLabel: window.windowLabel,
          windowGeneration: window.windowGeneration,
          panes: surface.panes.map((pane: any) => {
            const key = `${surface.surfaceId}\0${pane.paneId}\0${pane.paneLineageId}`;
            let allocation = panes.get(key);
            if (!allocation) {
              allocation = {
                allocationGeneration: Number.isSafeInteger(pane.allocationGeneration) && pane.allocationGeneration > 0
                  ? pane.allocationGeneration : nextGeneration++,
                paneLabel: Number.isSafeInteger(pane.paneLabel) && pane.paneLabel > 0
                  ? pane.paneLabel : releasedPaneLabels.shift() ?? nextPaneLabel++,
              };
              panes.set(key, allocation);
            }
            return { ...pane, ...allocation };
          }),
        };
      });
      socket.send(JSON.stringify({
        type: "response", v: 1, id: message.id, op: message.op, ok: true,
        payload: {
          clientId: payload.clientId,
          registryIdentity,
          directEndpoint: null,
          endpointLease: null,
          prePairDescribeV1: true,
          windowGenerationV1: true,
          completedPaneReleaseIds: (payload.pendingPaneReleases ?? []).map((release: any) => release.releaseId)
            .filter((releaseId: string) => completedPaneReleaseIds.has(releaseId)),
          completedWindowReleaseIds: (payload.pendingWindowReleases ?? []).map((release: any) => release.releaseId)
            .filter((releaseId: string) => completedWindowReleaseIds.has(releaseId)),
          surfaces,
        },
      }));
    });
  });
  return {
    server, requests, identityRequests, port, address: `ws://127.0.0.1:${port}/`,
    endpoint: {
      host: "127.0.0.1", port, wsPath: "/ws", protocolVersion: 1, role: "server", instanceName: "fixture",
    } as any,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function closeSurfaceWithAllocatedLabels(
  core: SurfaceCore,
  surfaceId: string,
  windowLabel: string,
  windowGeneration: number,
  paneLabel: number,
  paneGeneration: number,
): { paneId: number; paneLineageId: string; surfaceId: string } {
  const surface = core.getSurface(surfaceId);
  core.admitSurfaceToLockless(surfaceId);
  const pane = [...surface.panes.values()][0]!;
  core.applyWindowLabels([{ surfaceId, windowGeneration, windowLabel }]);
  core.applyRegistryPaneLabels([{
    surfaceId,
    panes: [{ allocationGeneration: paneGeneration, paneId: String(pane.paneId),
      paneLineageId: pane.paneLineageId, paneLabel }],
  }]);
  const savedSurface = core.getPersistentState().surfaces!.find((record) => record.surfaceId === surfaceId)!;
  core.locklessAuthority.recordSurfaceFinalClose({ ...savedSurface, topologyRevision: 1 }, [], { closeRevision: 2 });
  core.removeSurface(surfaceId, false);
  return { paneId: pane.paneId, paneLineageId: pane.paneLineageId, surfaceId };
}

test("pending window releases reach the registry before replacement claims", async () => {
  const clientId = "b".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_fixture", fleetId: "fixture-fleet" });
  const closedSurface = core.ensurePrimarySurface("Pending release", { width: 800, height: 600, scale: 1 });
  const oldClaim = closeSurfaceWithAllocatedLabels(core, closedSurface.surfaceId, "a", 8, 7, 9);
  const claimSurface = core.ensurePrimarySurface("Replacement surface", { width: 800, height: 600, scale: 1 });
  assert.notEqual(claimSurface.surfaceId, oldClaim.surfaceId);
  const claimPane = [...claimSurface.panes.values()][0]!;
  core.contentSet(claimSurface.surfaceId, {
    content: { markdown: "Replacement content" }, contentId: "ct_replacement_surface" as never,
    contentType: "markdown", historyOwnerToken: "hot_replacement_surface",
    paneId: claimPane.paneId as never, revision: 1 as never,
  });
  const oldPane = core.getPersistentState().lockless!.paneRetirementAudits[0]!;
  const registry = await automaticRegistryFixture({ seed: [{
    surfaceId: oldClaim.surfaceId,
    windowLabel: "a",
    windowGeneration: 8,
    panes: [{ paneId: oldClaim.paneId.toString(), paneLineageId: oldPane.lineageId,
      paneLabel: 7, allocationGeneration: 9 }],
  }] });
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {}, () => {}, 500);

  try {
    await registration.synchronize();
    assert.equal(registry.requests.length, 2);
    const releaseRegistration = registry.requests[0]!.message.payload;
    assert.deepEqual(releaseRegistration.surfaces, []);
    assert.equal(releaseRegistration.pendingWindowReleases.length, 1);
    assert.equal(releaseRegistration.pendingWindowReleases[0]!.windowGeneration, 8);
    assert.equal(releaseRegistration.pendingPaneReleases.length, 1);
    const claimRegistration = registry.requests[1]!.message.payload;
    assert.equal(claimRegistration.surfaces[0]!.surfaceId, claimSurface.surfaceId);
    assert.equal(claimRegistration.surfaces[0]!.windowGeneration, null);
    assert.deepEqual(claimRegistration.pendingWindowReleases, []);
    assert.deepEqual(claimRegistration.pendingPaneReleases, []);
    assert.equal("allocationGeneration" in releaseRegistration.pendingWindowReleases[0]!, false);
    assert.equal(core.locklessAuthority.listPendingWindowReleases().length, 0);
    assert.equal(core.locklessAuthority.listPendingPaneReleases().length, 0);
    assert.equal(core.getRendererWindowState(claimSurface.surfaceId).windowLabel, "a");
    assert.equal(core.getRendererWindowState(claimSurface.surfaceId).panes[0]?.label, "7");
    assert.equal(core.getRendererWindowState(claimSurface.surfaceId).panes[0]?.content.contentId, "ct_replacement_surface");
    assert.equal(core.getRendererWindowState(claimSurface.surfaceId).panes[0]?.content.content.markdown, "Replacement content");
    assert.ok(Number(core.listSurfaces()[0]!.windowAllocationGeneration) > 8);
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("an incomplete release acknowledgement keeps only that release pending", async () => {
  const central = await centralFixture();
  const clientId = "c".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Final close", { width: 800, height: 600, scale: 1 });
  core.admitSurfaceToLockless(surface.surfaceId);
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_fixture", fleetId: "fixture-fleet" });
  core.applyWindowLabels([{ surfaceId: surface.surfaceId, windowGeneration: 4, windowLabel: "a" }]);
  core.locklessAuthority.recordSurfaceFinalClose({
    panes: [],
    surfaceId: surface.surfaceId,
    topologyRevision: 1,
    windowAllocationGeneration: 4,
    windowLabel: "a",
  }, [], { closeRevision: 2 });
  core.removeSurface(surface.surfaceId, false);
  core.ensurePrimarySurface("Replacement surface", { width: 800, height: 600, scale: 1 });
  const connection = new ServerConnection({
    clientId,
    core,
    persist: async () => {},
    configuredAddress: central.address,
    discovery: emptyDiscovery(),
  });

  try {
    const sync = connection.synchronize();
    await until(() => central.requests.length === 1);
    assert.deepEqual(central.requests[0]!.message.payload.surfaces, []);
    central.reply(0, true, true, 700, undefined, undefined, {
      windowGenerationV1: true, completedWindowReleaseIds: [],
    });
    await until(() => central.requests.length === 2);
    assert.deepEqual(central.requests[1]!.message.payload.pendingWindowReleases, []);
    assert.deepEqual(central.requests[1]!.message.payload.surfaces, []);
    central.reply(1);
    await until(() => central.requests.length === 3);
    assert.equal(central.requests[2]!.message.payload.pendingWindowReleases[0]!.releaseId,
      core.locklessAuthority.listPendingWindowReleases()[0]!.releaseId);
    assert.deepEqual(central.requests[2]!.message.payload.surfaces, []);
    central.reply(2, true, true, 700, undefined, undefined, {
      windowGenerationV1: true, completedWindowReleaseIds: [],
    });
    await until(() => central.requests.length === 4);
    assert.deepEqual(central.requests[3]!.message.payload.pendingWindowReleases, []);
    assert.equal(central.requests[3]!.message.payload.surfaces[0]!.surfaceId, core.listSurfaces()[0]!.surfaceId);
    central.reply(3);
    await sync;
    assert.equal(core.locklessAuthority.listPendingWindowReleases().length, 1,
      "an incomplete acknowledgement leaves the exact durable release intent pending");
    assert.ok(Number(core.listSurfaces()[0]!.windowAllocationGeneration) > 0,
      "live registration succeeds independently of the unresolved release");
  } finally {
    await connection.stop();
    await central.close();
  }
});

test("registration cannot export a release from a lifecycle transaction that later rolls back", async () => {
  const central = await centralFixture();
  const clientId = "a".repeat(64);
  const surfaceId = "sf_registry_release_race";
  const lockless = createEmptyLocklessClientState({
    ...DEFAULT_LOCKLESS_LIMITS,
    maxRetainedTombstones: 1,
  });
  const core = new SurfaceCore({
    clientIdentity: clientId,
    persistentState: { lockless, primarySurfaceId: surfaceId, version: 1 },
  });
  const surface = core.ensurePrimarySurface("Release race", { width: 800, height: 600, scale: 1 });
  core.admitSurfaceToLockless(surface.surfaceId);
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_fixture", fleetId: "fixture-fleet" });
  const retained = core.locklessAuthority.createTombstone({
    kind: "pane",
    payload: {
      closeTopologyRevision: 4,
      pane: {
        allocationGeneration: 6,
        paneId: 8,
        paneLabel: 708,
        paneLineageId: "pl_release_race_retained",
      },
    },
    surfaceId,
  });

  let allowLifecycleFailure = (): void => {};
  const lifecycleFailure = new Promise<void>((resolve) => { allowLifecycleFailure = resolve; });
  let releaseCandidateCreated = (): void => {};
  const releaseCandidate = new Promise<void>((resolve) => { releaseCandidateCreated = resolve; });
  const lifecycle = core.locklessAuthority.transactionAsync(() =>
    core.transactionAsync(async () => {
      core.locklessAuthority.createTombstone({
        kind: "pane",
        payload: {
          closeTopologyRevision: 5,
          pane: {
            allocationGeneration: 7,
            paneId: 9,
            paneLabel: 709,
            paneLineageId: "pl_release_race_newer",
          },
        },
        surfaceId,
      });
      assert.equal(core.locklessAuthority.listPendingPaneReleases().length, 1);
      releaseCandidateCreated();
      await lifecycleFailure;
      throw new Error("simulated_lifecycle_persistence_failure");
    }),
  );
  await releaseCandidate;

  const persistedReleaseCounts: number[] = [];
  const registration = new ConfiguredServerRegistration(central.address, clientId, core,
    async () => { persistedReleaseCounts.push(core.locklessAuthority.listPendingPaneReleases().length); },
    () => {}, 500);
  try {
    const synchronizing = registration.synchronize();
    await until(() => central.identityRequests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(central.requests.length, 0,
      "registration waits behind the uncommitted lifecycle decision");
    assert.deepEqual(persistedReleaseCounts, [],
      "it does not persist or export the uncommitted release candidate");

    allowLifecycleFailure();
    await assert.rejects(lifecycle, /simulated_lifecycle_persistence_failure/);
    assert.deepEqual(core.locklessAuthority.listTombstones("pane").map((entry) => entry.tombstoneId),
      [retained.tombstoneId]);
    assert.deepEqual(core.locklessAuthority.listPendingPaneReleases(), []);

    await until(() => central.requests.length === 1);
    assert.deepEqual(central.requests[0]!.message.payload.pendingPaneReleases, []);
    assert.ok(persistedReleaseCounts.every((count) => count === 0));
    central.reply(0);
    await synchronizing;
    assert.deepEqual(core.locklessAuthority.listTombstones("pane").map((entry) => entry.tombstoneId),
      [retained.tombstoneId]);
  } finally {
    allowLifecycleFailure();
    await registration.stop();
    await central.close();
  }
});

test("confirmed fleet pane labels remain visible through a transient central disconnect", async () => {
  const central = await centralFixture();
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Registry label", { width: 800, height: 600, scale: 1 });
  core.admitSurfaceToLockless(surface.surfaceId);
  const registration = new ConfiguredServerRegistration(
    central.address, "registry-label-client", core, async () => {}, () => {}, 500,
  );
  try {
    const connecting = registration.synchronize();
    await until(() => central.requests.length === 1);
    assert.equal(central.requests[0]!.message.payload.allocationGenerationV1, true);
    central.reply(0, true, true);
    await connecting;

    const assigned = core.panesList(surface.surfaceId).panes[0]?.paneLabel;
    assert.equal(assigned, 700);

    const closed = new Promise<void>((resolve) => central.requests[0]!.socket.once("close", resolve));
    central.requests[0]!.socket.terminate();
    await closed;

    assert.equal(core.panesList(surface.surfaceId).panes[0]?.paneLabel, assigned);
    assert.equal(core.publicTopologyState(surface.surfaceId).panes[0]?.paneLabel, assigned);
    await registration.stop();
    assert.equal(core.panesList(surface.surfaceId).panes[0]?.paneLabel, assigned);
    assert.equal(core.publicTopologyState(surface.surfaceId).panes[0]?.paneLabel, assigned);
  } finally {
    await registration.stop();
    await central.close();
  }
});

test("central status waits for registration and persistence; loss, retry and reconnect preserve panes", async () => {
  const central = await centralFixture();
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Status", { width: 800, height: 600, scale: 1 });
  core.admitSurfaceToLockless(surface.surfaceId);
  const paneId = core.getRendererWindowState(surface.surfaceId).panes[0]!.paneId;
  for (const [index, name] of ["First", "Second"].entries()) {
    core.contentSet(surface.surfaceId, {
      content: { markdown: name }, contentId: `ct_status_${index}` as never,
      contentType: "markdown", historyOwnerToken: `hot_status_${index}`,
      paneId: paneId as never, revision: (index + 1) as never,
    });
  }
  core.navigateHistory(surface.surfaceId, paneId, "back");
  const persisted = deferred();
  const persistStarted = deferred();
  let blockPersistence = true;
  let persistenceCalls = 0;
  const connection = new ServerConnection({
    configuredAddress: central.address, clientId: "status-client", core,
    discovery: emptyDiscovery(), requestTimeoutMs: 500,
    persist: async () => {
      persistenceCalls += 1;
      if (blockPersistence && persistenceCalls > 1) { persistStarted.resolve(); await persisted.promise; }
    },
  });
  const state = () => core.getRendererWindowState(surface.surfaceId);
  try {
    const first = connection.synchronize();
    await until(() => central.requests.length === 1);
    assert.equal(state().connectionBar, "connecting", "open socket alone is insufficient");
    central.reply(0);
    await persistStarted.promise;
    assert.equal(state().connectionBar, "connecting", "registration must be persisted");
    blockPersistence = false;
    persisted.resolve();
    await first;
    assert.equal(state().connectionBar, "connected");
    assert.equal(state().windowLabel, "a");
    assert.equal(state().panes[0]?.label, "700");
    const registeredPanes = structuredClone(state().panes);
    central.requests[0]!.socket.terminate();
    await until(() => state().connectionBar === "disconnected");
    const reconnect = connection.synchronize();
    await until(() => central.requests.length === 2);
    assert.equal(state().connectionBar, "connecting");
    central.reply(1);
    await reconnect;
    assert.equal(state().connectionBar, "connected");
    assert.deepEqual(
      central.requests[1]!.message.payload.surfaces.map((registered: any) => ({
        surfaceId: registered.surfaceId,
        panes: registered.panes.map((pane: any) => ({
          paneId: pane.paneId, paneLabel: pane.paneLabel, paneLineageId: pane.paneLineageId,
        })),
      })),
      [{
        surfaceId: surface.surfaceId,
        panes: [{
          paneId: String(paneId), paneLabel: 700,
          paneLineageId: central.requests[0]!.message.payload.surfaces[0]!.panes[0]!.paneLineageId,
        }],
      }],
    );
    assert.deepEqual(state().panes, registeredPanes);
    core.navigateHistory(surface.surfaceId, paneId, "forward");
    assert.equal(state().panes[0]!.content.contentId, "ct_status_1");
    core.navigateHistory(surface.surfaceId, paneId, "back");
    assert.equal(state().panes[0]!.content.contentId, "ct_status_0");
  } finally {
    persisted.resolve();
    await connection.stop();
    await central.close();
  }
  assert.equal(state().connectionBar, "disconnected");
});

test("a configured endpoint without a valid identity falls back through Bonjour", async () => {
  const configured = await centralFixture(null, { deferIdentityReplies: true });
  const fallback = await centralFixture();
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Fallback", { width: 800, height: 600, scale: 1 });
  const discovery = emptyDiscovery();
  let advertised = true;
  discovery.getSnapshot = () => advertised ? [{
    host: "127.0.0.1", port: fallback.port, wsPath: "/ws", protocolVersion: 1, role: "server",
  }] : [];
  const connection = new ServerConnection({
    configuredAddress: configured.address, core, clientId: "fallback-client",
    persist: async () => {}, discovery, requestTimeoutMs: 100,
  });
  const status = () => core.getRendererWindowState(surface.surfaceId).connectionBar;
  try {
    const attempt = connection.synchronize();
    await until(() => configured.identityRequests.length === 1);
    await until(() => status() === "connecting");
    assert.equal(status(), "connecting");
    configured.replyIdentity(0);
    await until(() => fallback.requests.length === 1);
    await until(() => status() === "connecting");
    assert.equal(status(), "connecting");
    fallback.reply(0);
    await attempt;
    assert.equal(status(), "connected");
    const recovery = connection.synchronize();
    await until(() => fallback.requests.length === 2);
    fallback.reply(1);
    await recovery;
    assert.equal(status(), "connected");
    assert.equal(configured.identityRequests.length, 1,
      "a healthy bound registry is not displaced by a different configured endpoint");
    advertised = false;
    await fallback.close();
    await until(() => status() === "disconnected");
    const retry = connection.synchronize();
    const rejected = assert.rejects(retry, /no_surf_ace_server/);
    await until(() => configured.identityRequests.length >= 2);
    await rejected;
    assert.equal(status(), "disconnected");
  } finally {
    await connection.stop();
    await configured.close();
    if (fallback.server.address()) await fallback.close();
  }
});

test("discovery rejects an advertisement outside the v1 /ws contract", async () => {
  const original = ConfiguredServerRegistration.prototype.synchronize;
  const originalStop = ConfiguredServerRegistration.prototype.stop;
  const attempted: string[] = [];
  try {
    ConfiguredServerRegistration.prototype.synchronize = async function () {
      attempted.push((this as any).wire.url as string);
      throw new Error("invalid advertisement was contacted");
    };
    ConfiguredServerRegistration.prototype.stop = async () => {};
    const core = new SurfaceCore();
    const surface = core.ensurePrimarySurface("Invalid advertisement", { width: 800, height: 600, scale: 1 });
    const discovery = emptyDiscovery();
    discovery.getSnapshot = () => [
      {
        host: "server.local", port: 19001, wsPath: "/", protocolVersion: 1,
        role: "server", instanceName: "wrong-path",
      },
      {
        host: "server.local", port: 19002, wsPath: "/ws", protocolVersion: 0,
        role: "server", instanceName: "wrong-version",
      },
      {
        host: "0.0.0.0", port: 19003, wsPath: "/ws", protocolVersion: 1,
        role: "server", instanceName: "wildcard-target",
      },
    ] as any;
    const connection = new ServerConnection({
      clientId: "stable-client", core, discovery, persist: async () => {},
    });

    await assert.rejects(connection.synchronize(), /expected role=server v=1 ws=\/ws/);
    const state = core.getRendererWindowState(surface.surfaceId);
    assert.equal(state.connectionBar, "disconnected");
    assert.match(state.connectionError ?? "", /ws=\//);
    assert.match(state.connectionError ?? "", /v=0/);
    assert.match(state.connectionError ?? "", /wildcard address/);
    assert.deepEqual(attempted, []);
    await connection.stop();
  } finally {
    ConfiguredServerRegistration.prototype.synchronize = original;
    ConfiguredServerRegistration.prototype.stop = originalStop;
  }
});

test("underlying registration failure stays visible and logged until discovery reconnects", async () => {
  const central = await centralFixture();
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Retry diagnostic", { width: 800, height: 600, scale: 1 });
  const logs: string[] = [];
  const discovery = emptyDiscovery();
  let advertised = true;
  discovery.getSnapshot = () => advertised ? [{
    host: "127.0.0.1", port: central.port, wsPath: "/ws", protocolVersion: 1,
    role: "server", instanceName: "test registry", transportAddresses: ["127.0.0.1"],
  } as any] : [];
  const connection = new ServerConnection({
    clientId: "stable-retry-client", core, discovery, persist: async () => {},
    requestTimeoutMs: 500,
    onError: (error) => logs.push(error instanceof Error ? error.message : String(error)),
  });

  try {
    const first = connection.synchronize();
    await until(() => central.requests.length === 1);
    central.reply(0, true);
    await first;
    const registered = core.getRendererWindowState(surface.surfaceId);
    assert.equal(registered.windowLabel, "a");
    assert.equal(registered.panes[0]?.label, "700");
    const paneLineageId = central.requests[0]!.message.payload.surfaces[0]!.panes[0]!.paneLineageId;

    advertised = false;
    const retry = connection.synchronize();
    await until(() => central.requests.length === 2);
    central.reply(1, false);
    await until(() => central.requests.length === 3);
    central.reply(2, false);
    await assert.rejects(retry, /registration_rejected/);
    await until(() => core.getRendererWindowState(surface.surfaceId).connectionBar === "disconnected");

    const failed = core.getRendererWindowState(surface.surfaceId);
    assert.match(failed.connectionError ?? "", /registration_rejected/);
    assert.ok(logs.some((line) => /registration_rejected/.test(line)));
    assert.equal(failed.surfaceId, registered.surfaceId);
    assert.equal(failed.windowLabel, registered.windowLabel);
    assert.equal(failed.panes[0]?.paneId, registered.panes[0]?.paneId);
    assert.equal(failed.panes[0]?.label, registered.panes[0]?.label);

    advertised = true;
    const recovery = connection.synchronize();
    await until(() => central.requests.length === 4);
    central.reply(3, true);
    await recovery;

    const connected = core.getRendererWindowState(surface.surfaceId);
    assert.equal(connected.connectionBar, "connected");
    assert.equal(connected.connectionError, undefined);
    assert.equal(connected.windowLabel, "a");
    assert.equal(connected.panes[0]?.label, "700");
    assert.equal(connected.surfaceId, registered.surfaceId);
    assert.equal(connected.panes[0]?.paneId, registered.panes[0]?.paneId);
    assert.equal(connected.panes[0]?.label, registered.panes[0]?.label);
    for (const request of central.requests) {
      assert.equal(request.message.payload.clientId, "stable-retry-client");
      for (const registeredSurface of request.message.payload.surfaces) {
        for (const registeredPane of registeredSurface.panes) {
          assert.equal(registeredPane.paneLineageId, paneLineageId);
        }
      }
    }
  } finally {
    await connection.stop();
    await central.close();
  }
});

test("central closure while registration persists cannot publish connected", async () => {
  const central = await centralFixture();
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Closed", { width: 800, height: 600, scale: 1 });
  const entered = deferred();
  const release = deferred();
  const connection = new ServerConnection({
    configuredAddress: central.address, clientId: "closed-client", core,
    discovery: emptyDiscovery(), persist: async () => {
      if (core.confirmedRegistryClaims().length > 0) { entered.resolve(); await release.promise; }
    },
  });
  try {
    const attempt = assert.rejects(connection.synchronize(), /no_surf_ace_server/);
    await until(() => central.requests.length === 1);
    central.reply(0);
    await entered.promise;
    const closed = new Promise<void>((resolve) => central.requests[0]!.socket.once("close", resolve));
    central.requests[0]!.socket.terminate();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 10));
    release.resolve();
    await attempt;
    assert.equal(core.getRendererWindowState(surface.surfaceId).connectionBar, "disconnected");
  } finally {
    release.resolve();
    await connection.stop();
    await central.close();
  }
});

test("fresh install binds durably before the registry assigns visible labels", async () => {
  const registry = await centralFixture();
  const clientId = "e".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Fresh", { width: 800, height: 600, scale: 1 });
  const writes: ReturnType<typeof core.getPersistentState>[] = [];
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core,
    async () => { writes.push(core.getPersistentState()); }, () => {}, 500);
  try {
    const synchronizing = registration.synchronize();
    await until(() => registry.requests.length === 1);
    const request = registry.requests[0]!.message.payload;
    assert.equal(request.surfaces[0]!.surfaceId, surface.surfaceId);
    assert.equal(request.surfaces[0]!.windowGeneration, null);
    assert.ok(Number(request.surfaces[0]!.panes[0]!.paneId) > 0);
    assert.equal(request.surfaces[0]!.panes[0]!.paneLabel, 0);
    assert.equal(request.surfaces[0]!.panes[0]!.allocationGeneration, null);
    assert.deepEqual(request.pendingPaneReleases, []);
    assert.deepEqual(request.pendingWindowReleases, []);
    assert.deepEqual(core.registryBinding(), {
      clientId, allocatorId: "alloc_fixture", fleetId: "fixture-fleet",
    });
    assert.equal(writes[0]!.registryBindingPending, true);
    assert.equal(writes[0]!.surfaces![0]!.windowLabel, "");
    assert.equal(writes[0]!.surfaces![0]!.panes[0]!.paneLabel, 0);
    assert.equal(core.registryBindingPending(), true);
    assert.equal(core.panesList(surface.surfaceId).panes[0]?.paneLabel, null);
    assert.equal(core.getRendererWindowState(surface.surfaceId).windowLabel, "");
    registry.reply(0);
    await synchronizing;
    assert.equal(core.registryBindingPending(), false);
    assert.equal(core.getRendererWindowState(surface.surfaceId).windowLabel, "a");
    assert.equal(core.panesList(surface.surfaceId).panes[0]?.paneLabel, 700);
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("a registry with no saved allocations gives fresh labels without changing readable content", async () => {
  const clientId = "d".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Saved without registry record", { width: 800, height: 600, scale: 1 });
  const pane = [...surface.panes.values()][0]!;
  core.applyWindowLabels([{ surfaceId: surface.surfaceId, windowGeneration: 9, windowLabel: "d" }]);
  core.applyRegistryPaneLabels([{
    surfaceId: surface.surfaceId,
    panes: [{ allocationGeneration: 10, paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 703 }],
  }]);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "Readable while labels change" }, contentId: "ct_fresh_registry_labels" as never,
    contentType: "markdown", historyOwnerToken: "hot_fresh_registry_labels",
    paneId: pane.paneId as never, revision: 1 as Revision,
  });
  const registry = await centralFixture();
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {}, () => {}, 500);
  try {
    const synchronizing = registration.synchronize();
    await until(() => registry.requests.length === 1);
    const claim = registry.requests[0]!.message.payload.surfaces[0]!;
    assert.equal(claim.windowGeneration, null);
    assert.equal(claim.panes[0]!.paneLabel, 0);
    assert.equal(claim.panes[0]!.allocationGeneration, null);
    assert.equal(core.registryBindingPending(), true);
    assert.equal(core.getRendererWindowState(surface.surfaceId).windowLabel, "");
    assert.equal(core.panesList(surface.surfaceId).panes[0]?.paneLabel, null);
    assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.content.contentId, "ct_fresh_registry_labels");
    registry.reply(0, true, true, 700, "a");
    await synchronizing;
    const current = core.getRendererWindowState(surface.surfaceId);
    assert.equal(current.surfaceId, surface.surfaceId);
    assert.equal(current.windowLabel, "a");
    assert.equal(current.panes[0]?.paneId, pane.paneId);
    assert.equal(current.panes[0]?.paneLineageId, pane.paneLineageId);
    assert.equal(current.panes[0]?.label, "700");
    assert.equal(current.panes[0]?.content.contentId, "ct_fresh_registry_labels");
    assert.equal(core.registryBindingPending(), false);
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("saved labels are omitted during first binding and retained when the registry recognizes their identities", async () => {
  const clientId = "d".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Saved display", { width: 800, height: 600, scale: 1 });
  const pane = [...surface.panes.values()][0]!;
  core.applyWindowLabels([{ surfaceId: surface.surfaceId, windowGeneration: 9, windowLabel: "d" }]);
  core.applyRegistryPaneLabels([{
    surfaceId: surface.surfaceId,
    panes: [{ allocationGeneration: 10, paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 703 }],
  }]);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "Saved content" }, contentId: "ct_saved_binding" as never,
    contentType: "markdown", historyOwnerToken: "hot_saved_binding",
    paneId: pane.paneId as never, revision: 1 as never,
  });
  const oldSurfaceId = surface.surfaceId;
  const oldPaneId = pane.paneId;
  const oldLineageId = pane.paneLineageId;
  const registry = await automaticRegistryFixture({ seed: [{
    surfaceId: surface.surfaceId, windowLabel: "d", windowGeneration: 9,
    panes: [{ paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 703, allocationGeneration: 10 }],
  }] });
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {}, () => {}, 500);
  try {
    await registration.synchronize();
    const sent = registry.requests[0]!.message.payload.surfaces[0]!;
    assert.equal(sent.windowGeneration, null);
    assert.equal(sent.panes[0]!.paneLabel, 0);
    assert.equal(sent.panes[0]!.allocationGeneration, null);
    const state = core.getRendererWindowState(surface.surfaceId);
    assert.equal(state.surfaceId, oldSurfaceId);
    assert.equal(state.windowLabel, "d");
    assert.equal(state.panes[0]?.paneId, oldPaneId);
    assert.equal(state.panes[0]?.paneLineageId, oldLineageId);
    assert.equal(state.panes[0]?.label, "703");
    assert.equal(state.panes[0]?.content.contentId, "ct_saved_binding");
    assert.equal(core.getPersistentState().registryBindingPending, false);
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("first binding delivers earlier offline close releases before claiming the fresh window", async () => {
  const clientId = "4".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const closedSurface = core.ensurePrimarySurface("Closed while offline", { width: 800, height: 600, scale: 1 });
  const oldClaim = closeSurfaceWithAllocatedLabels(core, closedSurface.surfaceId, "a", 8, 7, 9);
  const live = core.ensurePrimarySurface("Replacement", { width: 800, height: 600, scale: 1 });
  const pane = [...live.panes.values()][0]!;
  core.contentSet(live.surfaceId, {
    content: { markdown: "Keep the open content" }, contentId: "ct_first_binding_release" as never,
    contentType: "markdown", historyOwnerToken: "hot_first_binding_release",
    paneId: pane.paneId as never, revision: 1 as Revision,
  });
  const registry = await automaticRegistryFixture({ seed: [{
    surfaceId: oldClaim.surfaceId,
    windowLabel: "a",
    windowGeneration: 8,
    panes: [{ paneId: String(oldClaim.paneId), paneLineageId: oldClaim.paneLineageId,
      paneLabel: 7, allocationGeneration: 9 }],
  }] });
  const expectedPaneReleaseIds = core.locklessAuthority.listPendingPaneReleases().map((release) => release.releaseId);
  const expectedWindowReleaseIds = core.locklessAuthority.listPendingWindowReleases().map((release) => release.releaseId);
  const persistedBeforeRequest: Array<{
    requestCount: number;
    state: ReturnType<typeof core.getPersistentState>;
  }> = [];
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {
    persistedBeforeRequest.push({ requestCount: registry.requests.length, state: core.getPersistentState() });
  }, () => {}, 500);
  try {
    await registration.synchronize();
    assert.ok(persistedBeforeRequest.some(({ requestCount, state }) => requestCount === 0 &&
      expectedPaneReleaseIds.every((releaseId) => state.lockless!.pendingPaneReleases.some((item) => item.releaseId === releaseId)) &&
      expectedWindowReleaseIds.every((releaseId) => state.lockless!.pendingWindowReleases.some((item) => item.releaseId === releaseId))));
    const [releaseRequest, claimRequest] = registry.requests.map((request) => request.message.payload);
    assert.deepEqual(releaseRequest.surfaces, []);
    assert.equal(releaseRequest.pendingWindowReleases.length, 1);
    assert.equal(releaseRequest.pendingPaneReleases.length, 1);
    assert.deepEqual(claimRequest.pendingWindowReleases, []);
    assert.deepEqual(claimRequest.pendingPaneReleases, []);
    assert.equal(claimRequest.surfaces[0]!.surfaceId, live.surfaceId);
    assert.equal(core.locklessAuthority.listPendingWindowReleases().length, 0);
    assert.equal(core.locklessAuthority.listPendingPaneReleases().length, 0);
    assert.equal(core.getRendererWindowState(live.surfaceId).windowLabel, "a");
    assert.equal(core.getRendererWindowState(live.surfaceId).panes[0]?.label, "7");
    assert.equal(core.getRendererWindowState(live.surfaceId).panes[0]?.content.contentId, "ct_first_binding_release");
    assert.deepEqual(core.registryBinding(), { clientId, allocatorId: "alloc_fixture", fleetId: "fixture-fleet" });
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("wholly undecodable saved state starts a fresh window and registers", async () => {
  const clientId = "2".repeat(64);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-unreadable-state-"));
  const fileName = "surface-state.json";
  const selectorPath = path.join(stateDir, persistentStateSelectorFileName(fileName));
  const statePath = path.join(stateDir, fileName);
  const registry = await automaticRegistryFixture();
  let registration: ConfiguredServerRegistration | null = null;
  try {
    const unreadable = new SurfaceCore({ clientIdentity: clientId });
    unreadable.ensurePrimarySurface("Unreadable saved window", { width: 800, height: 600, scale: 1 });
    await writePersistentStateFile(stateDir, fileName, unreadable.getPersistentState());
    await fs.writeFile(statePath, "{not valid saved state");
    await fs.writeFile(`${statePath}.bak`, "also not valid saved state");
    const selector = JSON.parse(await fs.readFile(selectorPath, "utf8"));
    assert.equal(selector.phase, "committed");

    const loaded = await loadPersistentStateFile(stateDir, fileName);
    assert.equal(loaded.writeGuard, "corrupt-primary");
    assert.equal(loaded.state, undefined);

    const core = new SurfaceCore({ clientIdentity: clientId, persistentState: loaded.state });
    const fresh = core.ensurePrimarySurface("Fresh after unreadable state", { width: 800, height: 600, scale: 1 });
    registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {
      await writePersistentStateFile(stateDir, fileName, core.getPersistentState());
    }, () => {}, 500);
    await registration.synchronize();

    const restored = await loadPersistentStateFile(stateDir, fileName);
    assert.equal(restored.writeGuard, false);
    assert.deepEqual(restored.state?.registryBinding, {
      clientId, allocatorId: "alloc_fixture", fleetId: "fixture-fleet",
    });
    assert.deepEqual(restored.state?.surfaces?.map((surface) => surface.surfaceId), [fresh.surfaceId]);
    assert.equal(core.getRendererWindowState(fresh.surfaceId).windowLabel, "a");
    assert.equal(core.getRendererWindowState(fresh.surfaceId).panes[0]?.label, "700");
    assert.equal(registry.requests.length, 1);
  } finally {
    await registration?.stop();
    await registry.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("unreadable pane records do not discard readable panes from the saved window", () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Partial restore", { width: 800, height: 600, scale: 1 });
  core.admitSurfaceToLockless(surface.surfaceId);
  const paneIds = [...surface.panes.keys()];
  core.paneSplit(surface.surfaceId, {
    count: 2, direction: "horizontal", newPaneIds: [paneIds[0]! + 1], newPaneLabels: [0], paneId: paneIds[0]!,
  });
  const firstPane = [...core.getSurface(surface.surfaceId).panes.values()][0]!;
  core.contentSet(surface.surfaceId, {
    content: { markdown: "Readable pane" }, contentId: "ct_readable_partial" as never,
    contentType: "markdown", historyOwnerToken: "hot_readable_partial",
    paneId: firstPane.paneId as never, revision: 1 as never,
  });
  const persisted = core.getPersistentState();
  persisted.surfaces![0]!.panes[1]!.history = [];
  const restored = new SurfaceCore({ persistentState: persisted });
  const restoredSurfaces = restored.restorePersistedSurfaces("Partial restore", { width: 800, height: 600, scale: 1 });
  assert.equal(restoredSurfaces.length, 1);
  const restoredState = restored.getRendererWindowState(surface.surfaceId);
  assert.equal(restoredState.panes.length, 2);
  assert.equal(restoredState.panes.find((pane) => pane.content.contentId === "ct_readable_partial")?.paneId, firstPane.paneId);
});

test("an unreadable saved window is skipped while readable windows register with their saved content", async () => {
  const clientId = "8".repeat(64);
  const savedCore = new SurfaceCore({ clientIdentity: clientId });
  const unreadable = savedCore.ensurePrimarySurface("Unreadable window", { width: 800, height: 600, scale: 1 });
  const readable = savedCore.createAdditionalSurface("Readable window", { width: 800, height: 600, scale: 1 });
  savedCore.admitSurfaceToLockless(unreadable.surfaceId);
  savedCore.admitSurfaceToLockless(readable.surfaceId);
  const pane = [...readable.panes.values()][0]!;
  savedCore.applyWindowLabels([{ surfaceId: unreadable.surfaceId, windowGeneration: 3, windowLabel: "a" }]);
  savedCore.applyRegistryPaneLabels([{
    surfaceId: unreadable.surfaceId,
    panes: [{ allocationGeneration: 4, paneId: String([...unreadable.panes.keys()][0]),
      paneLineageId: [...unreadable.panes.values()][0]!.paneLineageId, paneLabel: 21 }],
  }]);
  savedCore.applyWindowLabels([{ surfaceId: readable.surfaceId, windowGeneration: 5, windowLabel: "c" }]);
  savedCore.applyRegistryPaneLabels([{
    surfaceId: readable.surfaceId,
    panes: [{ allocationGeneration: 6, paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 23 }],
  }]);
  savedCore.contentSet(readable.surfaceId, {
    content: { markdown: "Readable window content" }, contentId: "ct_readable_window" as never,
    contentType: "markdown", historyOwnerToken: "hot_readable_window",
    paneId: pane.paneId as never, revision: 1 as Revision,
  });
  const saved = savedCore.getPersistentState();
  const unreadableIndex = saved.surfaces!.findIndex((surface) => surface.surfaceId === unreadable.surfaceId);
  (saved.surfaces as unknown[])[unreadableIndex] = null;
  const core = new SurfaceCore({ clientIdentity: clientId, persistentState: saved });
  const restoredSurfaces = core.restorePersistedSurfaces("Readable window", { width: 800, height: 600, scale: 1 });
  const registry = await automaticRegistryFixture({ seed: [{
    surfaceId: readable.surfaceId, windowLabel: "c", windowGeneration: 5,
    panes: [{ paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 23, allocationGeneration: 6 }],
  }] });
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {}, () => {}, 500);
  try {
    assert.deepEqual(restoredSurfaces.map((surface) => surface.surfaceId), [readable.surfaceId]);
    await registration.synchronize();
    assert.deepEqual(registry.requests[0]!.message.payload.surfaces.map((surface: any) => surface.surfaceId), [readable.surfaceId]);
    assert.equal(core.getRendererWindowState(readable.surfaceId).panes[0]?.content.contentId, "ct_readable_window");
    assert.equal(core.getRendererWindowState(readable.surfaceId).windowLabel, "c");
    assert.equal(core.getRendererWindowState(readable.surfaceId).panes[0]?.label, "23");
    assert.equal(core.registryBindingPending(), false);
    assert.equal(core.listSurfaces().some((surface) => surface.surfaceId === unreadable.surfaceId), false);
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("a matching discovered registry wins over an earlier foreign server advertisement", async () => {
  const clientId = "f".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Bound display", { width: 800, height: 600, scale: 1 });
  core.admitSurfaceToLockless(surface.surfaceId);
  const pane = [...surface.panes.values()][0]!;
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_home", fleetId: "fleet-home" });
  core.applyWindowLabels([{ surfaceId: surface.surfaceId, windowGeneration: 4, windowLabel: "c" }]);
  core.applyRegistryPaneLabels([{
    surfaceId: surface.surfaceId,
    panes: [{ allocationGeneration: 7, paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 23 }],
  }]);
  const home = await automaticRegistryFixture({
    identity: { allocatorId: "alloc_home", fleetId: "fleet-home" },
    seed: [{ surfaceId: surface.surfaceId, windowLabel: "c", windowGeneration: 4,
      panes: [{ paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 23, allocationGeneration: 7 }] }],
  });
  const foreign = await automaticRegistryFixture({ identity: { allocatorId: "alloc_other", fleetId: "fleet-other" } });
  const discovery = emptyDiscovery();
  discovery.getSnapshot = () => [foreign.endpoint, home.endpoint];
  const connection = new ServerConnection({ clientId, core, persist: async () => {}, discovery, requestTimeoutMs: 500 });
  try {
    await connection.synchronize();
    assert.equal(foreign.requests.length, 0);
    assert.equal(home.requests.length, 1);
    assert.deepEqual(core.registryBinding(), { clientId, allocatorId: "alloc_home", fleetId: "fleet-home" });
    assert.equal(core.getRendererWindowState(surface.surfaceId).windowLabel, "c");
    assert.equal(core.panesList(surface.surfaceId).panes[0]?.paneLabel, 23);
  } finally {
    await connection.stop();
    await foreign.close();
    await home.close();
  }
});

test("a matching registry restarted at a new address keeps its confirmed labels", async () => {
  const clientId = "7".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Restarted registry", { width: 800, height: 600, scale: 1 });
  core.admitSurfaceToLockless(surface.surfaceId);
  const pane = [...surface.panes.values()][0]!;
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_restart", fleetId: "fleet-restart" });
  core.applyWindowLabels([{ surfaceId: surface.surfaceId, windowGeneration: 4, windowLabel: "c" }]);
  core.applyRegistryPaneLabels([{
    surfaceId: surface.surfaceId,
    panes: [{ allocationGeneration: 7, paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 23 }],
  }]);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "Survive registry restart" }, contentId: "ct_registry_restart" as never,
    contentType: "markdown", historyOwnerToken: "hot_registry_restart",
    paneId: pane.paneId as never, revision: 1 as Revision,
  });
  const identity = { allocatorId: "alloc_restart", fleetId: "fleet-restart" };
  const oldAddress = await automaticRegistryFixture({ identity });
  const oldUrl = oldAddress.address;
  await oldAddress.close();
  const restartedRegistry = await automaticRegistryFixture({
    identity,
    seed: [{ surfaceId: surface.surfaceId, windowLabel: "c", windowGeneration: 4,
      panes: [{ paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 23, allocationGeneration: 7 }] }],
  });
  const discovery = emptyDiscovery();
  discovery.getSnapshot = () => [restartedRegistry.endpoint];
  const connection = new ServerConnection({ clientId, core, persist: async () => {}, discovery, requestTimeoutMs: 500 });
  try {
    assert.notEqual(restartedRegistry.address, oldUrl);
    await connection.synchronize();
    assert.deepEqual(core.registryBinding(), { clientId, ...identity });
    assert.equal(restartedRegistry.requests.length, 1);
    assert.equal(core.getRendererWindowState(surface.surfaceId).windowLabel, "c");
    assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.label, "23");
    assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.content.contentId, "ct_registry_restart");
  } finally {
    await connection.stop();
    await restartedRegistry.close();
  }
});

test("a bound client rebinds to the only valid registry with a different allocator", async () => {
  const clientId = "6".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Allocator replacement", { width: 800, height: 600, scale: 1 });
  core.admitSurfaceToLockless(surface.surfaceId);
  const pane = [...surface.panes.values()][0]!;
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_old", fleetId: "fleet-same" });
  core.applyWindowLabels([{ surfaceId: surface.surfaceId, windowGeneration: 4, windowLabel: "c" }]);
  core.applyRegistryPaneLabels([{
    surfaceId: surface.surfaceId,
    panes: [{ allocationGeneration: 7, paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 23 }],
  }]);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "Keep through allocator replacement" }, contentId: "ct_allocator_replacement" as never,
    contentType: "markdown", historyOwnerToken: "hot_allocator_replacement",
    paneId: pane.paneId as never, revision: 1 as Revision,
  });
  const registry = await automaticRegistryFixture({ identity: { allocatorId: "alloc_new", fleetId: "fleet-same" } });
  const connection = new ServerConnection({
    clientId, core, persist: async () => {}, discovery: emptyDiscovery(), configuredAddress: registry.address,
    requestTimeoutMs: 500, registryRebindWaitMs: 0,
  });
  try {
    await connection.synchronize();
    assert.deepEqual(core.registryBinding(), { clientId, allocatorId: "alloc_new", fleetId: "fleet-same" });
    assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.content.contentId, "ct_allocator_replacement");
    assert.equal(registry.requests.length, 1);
    assert.equal(registry.requests[0]!.message.payload.surfaces[0]!.windowGeneration, null);
  } finally {
    await connection.stop();
    await registry.close();
  }
});

test("a returned matching registry wins during the bounded rebinding wait", async () => {
  const clientId = "5".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Registry return", { width: 800, height: 600, scale: 1 });
  core.admitSurfaceToLockless(surface.surfaceId);
  const pane = [...surface.panes.values()][0]!;
  const matchingIdentity = { allocatorId: "alloc_home", fleetId: "fleet-home" };
  core.bindRegistryIdentity({ clientId, ...matchingIdentity });
  core.applyWindowLabels([{ surfaceId: surface.surfaceId, windowGeneration: 4, windowLabel: "c" }]);
  core.applyRegistryPaneLabels([{
    surfaceId: surface.surfaceId,
    panes: [{ allocationGeneration: 7, paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 23 }],
  }]);
  const matching = await automaticRegistryFixture({
    identity: matchingIdentity,
    seed: [{ surfaceId: surface.surfaceId, windowLabel: "c", windowGeneration: 4,
      panes: [{ paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 23, allocationGeneration: 7 }] }],
  });
  const foreign = await automaticRegistryFixture({ identity: { allocatorId: "alloc_other", fleetId: "fleet-other" } });
  let snapshot: any[] = [foreign.endpoint];
  const discovery = emptyDiscovery();
  discovery.getSnapshot = () => snapshot;
  discovery.refreshNow = async () => { snapshot = [matching.endpoint]; };
  const connection = new ServerConnection({
    clientId, core, persist: async () => {}, discovery, requestTimeoutMs: 500, registryRebindWaitMs: 100,
  });
  try {
    await connection.synchronize();
    assert.deepEqual(core.registryBinding(), { clientId, ...matchingIdentity });
    assert.equal(matching.requests.length, 1);
    assert.equal(foreign.requests.length, 0);
    assert.equal(core.getRendererWindowState(surface.surfaceId).windowLabel, "c");
    assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.label, "23");
  } finally {
    await connection.stop();
    await foreign.close();
    await matching.close();
  }
});

test("a surface advertisement without the server role cannot rebind a bound client", async () => {
  const clientId = "3".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  core.ensurePrimarySurface("Server role filter", { width: 800, height: 600, scale: 1 });
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_home", fleetId: "fleet-home" });
  const discovery = emptyDiscovery();
  discovery.getSnapshot = () => [{
    host: "surface.local", port: 19001, wsPath: "/ws", protocolVersion: 1, role: "surface", instanceName: "Surface",
  } as any];
  const connection = new ServerConnection({ clientId, core, persist: async () => {}, discovery, requestTimeoutMs: 100 });
  try {
    await assert.rejects(connection.synchronize(), /no_surf_ace_server/);
    assert.deepEqual(core.registryBinding(), { clientId, allocatorId: "alloc_home", fleetId: "fleet-home" });
    assert.equal(core.registryBindingPending(), false);
  } finally {
    await connection.stop();
  }
});

test("rebinding keeps readable content and holds old-registry release evidence inert", async () => {
  const clientId = "a".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const live = core.ensurePrimarySurface("Live display", { width: 800, height: 600, scale: 1 });
  const livePane = [...live.panes.values()][0]!;
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_old", fleetId: "fleet-old" });
  core.applyWindowLabels([{ surfaceId: live.surfaceId, windowGeneration: 5, windowLabel: "b" }]);
  core.applyRegistryPaneLabels([{
    surfaceId: live.surfaceId,
    panes: [{ allocationGeneration: 6, paneId: String(livePane.paneId), paneLineageId: livePane.paneLineageId, paneLabel: 32 }],
  }]);
  core.contentSet(live.surfaceId, {
    content: { markdown: "Keep this content" }, contentId: "ct_rebind_live" as never,
    contentType: "markdown", historyOwnerToken: "hot_rebind_live",
    paneId: livePane.paneId as never, revision: 1 as never,
  });
  const closed = core.createAdditionalSurface("Already closed", { width: 800, height: 600, scale: 1 });
  core.applyWindowLabels([{ surfaceId: closed.surfaceId, windowGeneration: 11, windowLabel: "e" }]);
  core.locklessAuthority.recordSurfaceFinalClose({
    panes: [], surfaceId: closed.surfaceId, topologyRevision: 1,
    windowAllocationGeneration: 11, windowLabel: "e",
  }, [], { closeRevision: 2 });
  core.removeSurface(closed.surfaceId, false);
  const oldRelease = core.locklessAuthority.listPendingWindowReleases()[0]!;
  const next = await automaticRegistryFixture({ identity: { allocatorId: "alloc_new", fleetId: "fleet-new" } });
  const connection = new ServerConnection({
    configuredAddress: next.address, clientId, core, persist: async () => {}, discovery: emptyDiscovery(), requestTimeoutMs: 500,
  });
  try {
    await connection.synchronize();
    assert.deepEqual(core.registryBinding(), { clientId, allocatorId: "alloc_new", fleetId: "fleet-new" });
    assert.equal(next.requests.length, 1);
    const request = next.requests[0]!.message.payload;
    assert.deepEqual(request.pendingPaneReleases, []);
    assert.deepEqual(request.pendingWindowReleases, []);
    assert.equal(request.surfaces[0]!.surfaceId, live.surfaceId);
    assert.equal(request.surfaces[0]!.windowGeneration, null);
    assert.equal(request.surfaces[0]!.panes[0]!.paneLabel, 0);
    assert.equal(core.locklessAuthority.listPendingWindowReleases().length, 0);
    assert.ok(core.getPersistentState().lockless!.windowRetirementAudits.some((entry) => entry.releaseId === oldRelease.releaseId));
    assert.deepEqual(next.requests[0]!.message.payload.pendingWindowReleases, []);
    assert.ok(core.getPersistentState().lockless!.windowRetirementAudits.some((entry) =>
      entry.releaseId === oldRelease.releaseId && entry.windowLabel === oldRelease.windowLabel &&
      entry.windowGeneration === oldRelease.windowGeneration));
    const state = core.getRendererWindowState(live.surfaceId);
    assert.equal(state.panes[0]?.content.contentId, "ct_rebind_live");
    assert.equal(state.windowLabel, "a");
    assert.equal(state.panes[0]?.label, "700");
    assert.equal(core.listSurfaces().some((surface) => surface.surfaceId === closed.surfaceId), false);
  } finally {
    await connection.stop();
    await next.close();
  }
});

test("a former registry is ignored while the current binding is reachable and eligible after it disappears", async () => {
  const clientId = "c".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Bound display", { width: 800, height: 600, scale: 1 });
  const pane = [...surface.panes.values()][0]!;
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_old", fleetId: "fleet-old" });
  core.contentSet(surface.surfaceId, {
    content: { markdown: "Keep across registry changes" }, contentId: "ct_rebind_again" as never,
    contentType: "markdown", historyOwnerToken: "hot_rebind_again",
    paneId: pane.paneId as never, revision: 1 as Revision,
  });
  const oldRegistry = await automaticRegistryFixture({ identity: { allocatorId: "alloc_old", fleetId: "fleet-old" } });
  const newRegistry = await automaticRegistryFixture({ identity: { allocatorId: "alloc_new", fleetId: "fleet-new" } });
  const discovery = emptyDiscovery();
  discovery.getSnapshot = () => [newRegistry.endpoint];
  const firstConnection = new ServerConnection({ clientId, core, persist: async () => {}, discovery, requestTimeoutMs: 500 });
  let preferenceConnection: ServerConnection | null = null;
  let fallbackConnection: ServerConnection | null = null;
  let newRegistryClosed = false;
  try {
    await firstConnection.synchronize();
    assert.deepEqual(core.registryBinding(), { clientId, allocatorId: "alloc_new", fleetId: "fleet-new" });
    await firstConnection.stop();

    discovery.getSnapshot = () => [oldRegistry.endpoint, newRegistry.endpoint];
    preferenceConnection = new ServerConnection({ clientId, core, persist: async () => {}, discovery, requestTimeoutMs: 500 });
    await preferenceConnection.synchronize();
    assert.equal(newRegistry.requests.length, 2);
    assert.equal(oldRegistry.requests.length, 0);
    assert.deepEqual(core.registryBinding(), { clientId, allocatorId: "alloc_new", fleetId: "fleet-new" });
    await preferenceConnection.stop();

    await newRegistry.close();
    newRegistryClosed = true;
    discovery.getSnapshot = () => [oldRegistry.endpoint];

    fallbackConnection = new ServerConnection({ clientId, core, persist: async () => {}, discovery, requestTimeoutMs: 500 });
    await fallbackConnection.synchronize();

    assert.deepEqual(core.registryBinding(), { clientId, allocatorId: "alloc_old", fleetId: "fleet-old" });
    assert.equal(oldRegistry.requests.length, 1);
    assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.content.contentId, "ct_rebind_again");
  } finally {
    await firstConnection.stop();
    await preferenceConnection?.stop();
    await fallbackConnection?.stop();
    await oldRegistry.close();
    if (!newRegistryClosed) await newRegistry.close();
  }
});

test("a refused live pane claim gets a fresh identity while its content and position remain", async () => {
  const clientId = "b".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Refused pane", { width: 800, height: 600, scale: 1 });
  const pane = [...surface.panes.values()][0]!;
  pane.paneLineageId = "pl_refused_claim";
  core.contentSet(surface.surfaceId, {
    content: { markdown: "Pane survives refusal" }, contentId: "ct_refused_pane" as never,
    contentType: "markdown", historyOwnerToken: "hot_refused_pane",
    paneId: pane.paneId as never, revision: 1 as never,
  });
  const oldPaneId = pane.paneId;
  const oldLineageId = pane.paneLineageId;
  const registry = await automaticRegistryFixture({
    rejectClaim: (payload) => payload.surfaces.some((item: any) =>
      item.panes.some((candidate: any) => candidate.paneLineageId === oldLineageId)),
  });
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {}, () => {}, 500);
  try {
    await registration.synchronize();
    assert.ok(registry.requests.some((request) => request.message.payload.surfaces.some((item: any) =>
      item.panes.some((candidate: any) => candidate.paneLineageId === oldLineageId))));
    assert.ok(registry.requests.every((request) => request.message.payload.pendingPaneReleases.length === 0));
    const state = core.getRendererWindowState(surface.surfaceId);
    assert.equal(state.panes[0]?.content.contentId, "ct_refused_pane");
    assert.notEqual(state.panes[0]?.paneId, oldPaneId);
    assert.notEqual(state.panes[0]?.paneLineageId, oldLineageId);
    assert.equal(state.panes[0]?.label, "700");
    assert.equal(core.getSurface(surface.surfaceId).paneOrder[0], state.panes[0]?.paneId);
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("a refused live surface gets a fresh identity while its content and window placement remain", async () => {
  const clientId = "c".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Refused surface", { width: 800, height: 600, scale: 1 });
  const pane = [...surface.panes.values()][0]!;
  core.contentSet(surface.surfaceId, {
    content: { markdown: "Surface survives refusal" }, contentId: "ct_refused_surface" as never,
    contentType: "markdown", historyOwnerToken: "hot_refused_surface",
    paneId: pane.paneId as never, revision: 1 as never,
  });
  core.setWindowPlacement(surface.surfaceId, {
    bounds: { x: 10, y: 20, width: 700, height: 500 }, displayId: 1, fullscreen: false,
  });
  const oldSurfaceId = surface.surfaceId;
  const oldLineage = pane.paneLineageId;
  const registry = await automaticRegistryFixture({
    rejectClaim: (payload) => payload.surfaces.some((item: any) => item.surfaceId === oldSurfaceId),
  });
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {}, () => {}, 500);
  try {
    await registration.synchronize();
    const replacement = core.listSurfaces()[0]!;
    assert.notEqual(replacement.surfaceId, oldSurfaceId);
    const state = core.getRendererWindowState(replacement.surfaceId);
    assert.equal(state.panes[0]?.content.contentId, "ct_refused_surface");
    assert.notEqual(state.panes[0]?.paneLineageId, oldLineage);
    assert.deepEqual(core.getWindowPlacement(replacement.surfaceId), {
      bounds: { x: 10, y: 20, width: 700, height: 500 }, displayId: 1, fullscreen: false,
    });
    assert.equal(state.windowLabel, "a");
    assert.equal(state.panes[0]?.label, "700");
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("a refused release is dropped only after the identical retry fails and the live registration succeeds", async () => {
  const clientId = "9".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Release refusal", { width: 800, height: 600, scale: 1 });
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_fixture", fleetId: "fixture-fleet" });
  core.locklessAuthority.recordPaneFinalClose({ closeTopologyRevision: 5, pane: {
    allocationGeneration: 7, paneId: 9, paneLabel: 709, paneLineageId: "pl_refused_release",
  } }, { closeRevision: 5, surfaceId: surface.surfaceId });
  const release = core.locklessAuthority.listPendingPaneReleases()[0]!;
  assert.ok(release.releaseId);
  const registry = await automaticRegistryFixture({ rejectReleaseIds: new Set([release.releaseId]) });
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {}, () => {}, 500);
  try {
    await registration.synchronize();
    const attempts = registry.requests.filter((request) =>
      request.message.payload.pendingPaneReleases.some((item: any) => item.releaseId === release.releaseId));
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts.map((request) => request.message.payload.pendingPaneReleases[0]), [release, release, release]);
    assert.equal(core.locklessAuthority.listPendingPaneReleases().length, 0);
    assert.ok(core.getPersistentState().lockless!.paneRetirementAudits.some((entry) => entry.releaseId === release.releaseId));
    assert.equal(core.getRendererWindowState(surface.surfaceId).connectionBar, "disconnected");
    assert.equal(core.getRendererWindowState(surface.surfaceId).panes.length, 1);
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("a mixed release request completes its accepted release and drops only the refused release", async () => {
  const clientId = "1".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_fixture", fleetId: "fixture-fleet" });
  const first = core.ensurePrimarySurface("First close", { width: 800, height: 600, scale: 1 });
  const second = core.createAdditionalSurface("Second close", { width: 800, height: 600, scale: 1 });
  const closeWindow = (surfaceId: string, label: string, generation: number) => {
    core.admitSurfaceToLockless(surfaceId);
    core.applyWindowLabels([{ surfaceId, windowGeneration: generation, windowLabel: label }]);
    const record = core.getPersistentState().surfaces!.find((surface) => surface.surfaceId === surfaceId)!;
    core.locklessAuthority.recordSurfaceFinalClose({ ...record, panes: [], topologyRevision: 1 }, [], { closeRevision: 2 });
    core.removeSurface(surfaceId, false);
  };
  closeWindow(first.surfaceId, "a", 8);
  closeWindow(second.surfaceId, "b", 9);
  const releaseOne = core.locklessAuthority.listPendingWindowReleases().find((release) => release.surfaceId === first.surfaceId)!;
  const releaseTwo = core.locklessAuthority.listPendingWindowReleases().find((release) => release.surfaceId === second.surfaceId)!;
  const replacement = core.ensurePrimarySurface("After closes", { width: 800, height: 600, scale: 1 });
  const registry = await automaticRegistryFixture({
    rejectReleaseIds: new Set([releaseTwo.releaseId]),
    seed: [
      { surfaceId: first.surfaceId, windowLabel: "a", windowGeneration: 8, panes: [] },
      { surfaceId: second.surfaceId, windowLabel: "b", windowGeneration: 9, panes: [] },
    ],
  });
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {}, () => {}, 500);
  try {
    await registration.synchronize();
    const combined = registry.requests[0]!.message.payload;
    assert.deepEqual(combined.surfaces, []);
    assert.deepEqual(combined.pendingWindowReleases.map((release: any) => release.releaseId),
      [releaseOne.releaseId, releaseTwo.releaseId]);
    const claimRequest = registry.requests.at(-1)!.message.payload;
    assert.deepEqual(claimRequest.pendingWindowReleases, []);
    assert.equal(claimRequest.surfaces[0]!.surfaceId, replacement.surfaceId);
    assert.equal(core.getRendererWindowState(replacement.surfaceId).windowLabel, "a");
    assert.equal(core.locklessAuthority.listPendingWindowReleases().length, 0);
    assert.ok(core.getPersistentState().lockless!.windowRetirementAudits.some((entry) =>
      entry.releaseId === releaseOne.releaseId));
    assert.ok(core.getPersistentState().lockless!.windowRetirementAudits.some((entry) =>
      entry.releaseId === releaseTwo.releaseId));
    assert.deepEqual(claimRequest.pendingWindowReleases, []);
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("a registry-wide rejection keeps a release pending until the condition clears", async () => {
  const clientId = "0".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_fixture", fleetId: "fixture-fleet" });
  const closed = core.ensurePrimarySurface("Close before condition", { width: 800, height: 600, scale: 1 });
  const closedClaim = closeSurfaceWithAllocatedLabels(core, closed.surfaceId, "a", 8, 7, 9);
  const replacement = core.ensurePrimarySurface("Retry after condition", { width: 800, height: 600, scale: 1 });
  const release = core.locklessAuthority.listPendingWindowReleases()[0]!;
  let rejects = true;
  const registry = await automaticRegistryFixture({
    rejectRegistration: () => rejects,
    seed: [{ surfaceId: closedClaim.surfaceId, windowLabel: "a", windowGeneration: 8,
      panes: [{ paneId: String(closedClaim.paneId), paneLineageId: closedClaim.paneLineageId,
        paneLabel: 7, allocationGeneration: 9 }] }],
  });
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {}, () => {}, 500);
  try {
    await assert.rejects(registration.synchronize(), /registration_condition/);
    assert.deepEqual(core.locklessAuthority.listPendingWindowReleases().map((item) => item.releaseId), [release.releaseId]);
    assert.equal(core.registryBindingPending(), false);

    rejects = false;
    await registration.synchronize();
    assert.equal(core.locklessAuthority.listPendingWindowReleases().length, 0);
    assert.equal(core.getRendererWindowState(replacement.surfaceId).windowLabel, "a");
    assert.equal(registry.requests.at(-1)!.message.payload.surfaces[0]!.surfaceId, replacement.surfaceId);
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("a retained pre-binding surface restores with pending labels and registers its same identity", async () => {
  const clientId = "8".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const retained = core.ensurePrimarySurface("Retained content", { width: 800, height: 600, scale: 1 });
  const pane = [...retained.panes.values()][0]!;
  core.applyWindowLabels([{ surfaceId: retained.surfaceId, windowGeneration: 5, windowLabel: "f" }]);
  core.applyRegistryPaneLabels([{
    surfaceId: retained.surfaceId,
    panes: [{ allocationGeneration: 6, paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 44 }],
  }]);
  core.contentSet(retained.surfaceId, {
    content: { markdown: "Retained" }, contentId: "ct_retained_binding" as never,
    contentType: "markdown", historyOwnerToken: "hot_retained_binding",
    paneId: pane.paneId as never, revision: 1 as never,
  });
  const record = core.captureSurfaceTombstonePayload(retained.surfaceId);
  core.locklessAuthority.createTombstone({ kind: "surface", payload: { paneTombstones: [], surface: record }, surfaceId: retained.surfaceId });
  core.removeSurface(retained.surfaceId);
  const fresh = core.ensurePrimarySurface("New window", { width: 800, height: 600, scale: 1 });
  const registry = await automaticRegistryFixture();
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {}, () => {}, 500);
  try {
    await registration.synchronize();
    assert.equal(registry.requests[0]!.message.payload.surfaces.length, 1);
    assert.equal(registry.requests[0]!.message.payload.surfaces[0]!.surfaceId, fresh.surfaceId);
    const storedTombstone = core.locklessAuthority.listTombstones("surface")[0]!.payload as any;
    assert.equal(storedTombstone.surface.windowLabel, "");
    assert.equal(storedTombstone.surface.panes[0]!.paneLabel, 0);
    core.restoreSurfaceTombstone(storedTombstone.surface);
    const restoredState = core.getRendererWindowState(retained.surfaceId);
    assert.equal(restoredState.panes[0]?.content.contentId, "ct_retained_binding");
    assert.equal(restoredState.windowLabel, "");
    assert.equal(restoredState.panes[0]?.label, "");
    const retry = registration.synchronize();
    await until(() => registry.requests.length === 2);
    await retry;
    assert.equal(core.getRendererWindowState(retained.surfaceId).panes[0]?.content.contentId, "ct_retained_binding");
    assert.equal(core.getRendererWindowState(retained.surfaceId).windowLabel, "b");
    assert.equal(core.panesList(retained.surfaceId).panes[0]?.paneLabel, 701);
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("interrupted first binding write refuses registration and preserves display state", async () => {
  const registry = await centralFixture();
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Read-only display", { width: 800, height: 600, scale: 1 });
  const paneId = [...surface.panes.keys()][0]!;
  core.contentSet(surface.surfaceId, {
    content: { markdown: "Preserved pixels" }, contentId: "ct_registry_bind" as never,
    contentType: "markdown", historyOwnerToken: "hot_registry_bind",
    paneId: paneId as never, revision: 1 as never,
  });
  const before = core.getPersistentState();
  const beforeDisplay = core.getRendererWindowState(surface.surfaceId);
  const connection = new ConfiguredServerRegistration(registry.address, "fresh-client", core,
    async () => { throw new Error("binding_write_interrupted"); }, () => {}, 200);
  try {
    await assert.rejects(connection.synchronize(), /binding_write_interrupted/);
    assert.equal(registry.identityRequests.length, 1);
    assert.equal(registry.requests.length, 0);
    assert.equal(core.registryBinding(), null);
    assert.equal(core.registryBindingPending(), false);
    assert.deepEqual(core.getPersistentState(), before);
    const after = core.getRendererWindowState(surface.surfaceId);
    assert.equal(after.surfaceId, beforeDisplay.surfaceId);
    assert.equal(after.name, beforeDisplay.name);
    assert.equal(after.panes[0]?.paneLineageId, beforeDisplay.panes[0]?.paneLineageId);
    assert.equal(after.panes[0]?.content.contentId, "ct_registry_bind");
    assert.equal(after.panes[0]?.label, "");
    assert.equal(after.windowLabel, "");
  } finally {
    await connection.stop();
    await registry.close();
  }
});

test("registration response with a foreign identity cannot apply labels after matching preflight", async () => {
  const registry = await centralFixture({ allocatorId: "alloc_home", fleetId: "fleet-home" });
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Response identity", { width: 800, height: 600, scale: 1 });
  const registration = new ConfiguredServerRegistration(registry.address, "response-client", core, async () => {}, () => {}, 200);
  try {
    const connecting = registration.synchronize();
    await until(() => registry.requests.length === 1);
    registry.reply(0, true, true, 700, "a", { allocatorId: "alloc_foreign", fleetId: "fleet-foreign" });
    await assert.rejects(connecting, /foreign_registry_identity/);
    const missing = registration.synchronize();
    await until(() => registry.requests.length === 2);
    registry.reply(1, true, true, 700, "a", null);
    await assert.rejects(missing, /registry_identity_missing_or_invalid/);
    assert.deepEqual(core.registryBinding(), {
      clientId: "response-client", allocatorId: "alloc_home", fleetId: "fleet-home",
    });
    assert.equal(core.panesList(surface.surfaceId).panes[0]?.paneLabel, null);
  } finally {
    await registration.stop();
    await registry.close();
  }
});

test("ambiguous binding candidate cannot register until persistence is reconciled", async () => {
  const registry = await centralFixture();
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Uncertain binding", { width: 800, height: 600, scale: 1 });
  let reconciled = false;
  const registration = new ConfiguredServerRegistration(registry.address, "uncertain-client", core,
    async () => {
      if (!reconciled) {
        const error = new Error("binding_outcome_unknown");
        error.name = "PersistentStateOutcomeUnknownError";
        throw error;
      }
    }, () => {}, 200);
  try {
    await assert.rejects(registration.synchronize(), /binding_outcome_unknown/);
    assert.deepEqual(core.registryBinding(), {
      clientId: "uncertain-client", allocatorId: "alloc_fixture", fleetId: "fixture-fleet",
    });
    await assert.rejects(registration.synchronize(), /binding_outcome_unknown/);
    assert.equal(registry.requests.length, 0);
    reconciled = true;
    const retry = registration.synchronize();
    await until(() => registry.requests.length === 1);
    registry.reply(0);
    await retry;
    assert.equal(core.registryBindingPending(), false);
    assert.equal(core.getRendererWindowState(surface.surfaceId).windowLabel, "a");
  } finally {
    await registration.stop();
    await registry.close();
  }
});
