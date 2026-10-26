import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { ServerConnection } from "../src/server-connection.js";
import { ConfiguredServerRegistration } from "../src/configured-server.js";
import { SurfaceCore } from "../src/surface-core.js";
import { createEmptyLocklessClientState, DEFAULT_LOCKLESS_LIMITS } from "../src/lockless-client-authority.js";

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

async function centralFixture(registryIdentity: { allocatorId: string; fleetId: string } | null =
  { allocatorId: "alloc_fixture", fleetId: "fixture-fleet" }) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const requests: Array<{ socket: WebSocket; message: any }> = [];
  const identityRequests: Array<{ socket: WebSocket; message: any }> = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.op === "fleet.topology") {
        identityRequests.push({ socket, message });
        socket.send(JSON.stringify({
          type: "response", v: 1, id: message.id, op: message.op, ok: true,
          payload: registryIdentity ? { registryIdentity } : {},
        }));
      } else {
        requests.push({ socket, message });
      }
    });
  });
  return {
    server, requests, identityRequests, port, address: `ws://127.0.0.1:${port}/`,
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
  for (const surface of options.seed ?? []) {
    windows.set(surface.surfaceId, { windowGeneration: surface.windowGeneration, windowLabel: surface.windowLabel });
    for (const pane of surface.panes) {
      panes.set(`${surface.surfaceId}\0${pane.paneId}\0${pane.paneLineageId}`, {
        allocationGeneration: pane.allocationGeneration, paneLabel: pane.paneLabel,
      });
    }
  }
  let nextWindowIndex = 0;
  let nextPaneLabel = 700;
  let nextGeneration = 1;
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
      const hasRejectedRelease = [...(options.rejectReleaseIds ?? [])].some((releaseId) =>
        [...(payload.pendingPaneReleases ?? []), ...(payload.pendingWindowReleases ?? [])]
          .some((release: any) => release.releaseId === releaseId));
      if (options.rejectClaim?.(payload) || hasRejectedRelease) {
        socket.send(JSON.stringify({
          type: "response", v: 1, id: message.id, op: message.op, ok: false,
          error: { code: "registration_failed", message: hasRejectedRelease ? "release_refused" : "claim_refused" },
        }));
        return;
      }
      const surfaces = payload.surfaces.map((surface: any) => {
        let window = windows.get(surface.surfaceId);
        if (!window) {
          window = {
            windowGeneration: Number.isSafeInteger(surface.windowGeneration) && surface.windowGeneration > 0
              ? surface.windowGeneration : nextGeneration++,
            windowLabel: String.fromCharCode(97 + nextWindowIndex++),
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
                paneLabel: Number.isSafeInteger(pane.paneLabel) && pane.paneLabel > 0 ? pane.paneLabel : nextPaneLabel++,
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
          completedPaneReleaseIds: (payload.pendingPaneReleases ?? []).map((release: any) => release.releaseId),
          completedWindowReleaseIds: (payload.pendingWindowReleases ?? []).map((release: any) => release.releaseId),
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

test("pending window releases block pane claims until the registry acknowledges them", async () => {
  const central = await centralFixture();
  const clientId = "b".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Pending release", { width: 800, height: 600, scale: 1 });
  core.admitSurfaceToLockless(surface.surfaceId);
  core.bindRegistryIdentity({ clientId, allocatorId: "alloc_fixture", fleetId: "fixture-fleet" });
  core.applyWindowLabels([{ surfaceId: surface.surfaceId, windowGeneration: 8, windowLabel: "a" }]);
  core.locklessAuthority.recordSurfaceFinalClose({
    panes: [],
    surfaceId: surface.surfaceId,
    topologyRevision: 1,
    windowAllocationGeneration: 8,
    windowLabel: "a",
  }, [], { closeRevision: 2 });
  core.removeSurface(surface.surfaceId, false);
  const claimSurface = core.ensurePrimarySurface("Replacement surface", { width: 800, height: 600, scale: 1 });
  core.admitSurfaceToLockless(claimSurface.surfaceId);
  const connection = new ServerConnection({
    clientId,
    core,
    persist: async () => {},
    configuredAddress: central.address,
    discovery: emptyDiscovery(),
  });

  try {
    const firstSync = connection.synchronize();
    await until(() => central.requests.length === 1);
    const registration = central.requests[0]!.message.payload;
    assert.equal(registration.windowGenerationV1, true);
    assert.equal(registration.surfaces[0]!.windowGeneration, null);
    assert.deepEqual(registration.pendingWindowReleases, []);
    central.reply(0);
    await until(() => central.requests.length === 2);
    assert.equal(central.requests[1]!.message.payload.pendingWindowReleases.length, 1);
    assert.equal(central.requests[1]!.message.payload.pendingWindowReleases[0]!.windowGeneration, 8);
    assert.equal("allocationGeneration" in central.requests[1]!.message.payload.pendingWindowReleases[0]!, false);
    central.reply(1);
    await firstSync;
    assert.equal(core.locklessAuthority.listPendingWindowReleases().length, 0);
    assert.ok(Number(core.listSurfaces()[0]!.windowAllocationGeneration) > 0);
    const claim = connection.claimPaneLabel(claimSurface.surfaceId, 20, "pl_claim_after_close");
    await until(() => central.requests.length === 3);
    assert.equal(central.requests[2]!.message.op, "pane.claim");
    central.requests[2]!.socket.send(JSON.stringify({
      type: "response", v: 1, id: central.requests[2]!.message.id, op: "pane.claim", ok: true,
      payload: { allocationGeneration: 9, paneLabel: 2 },
    }));
    assert.deepEqual(await claim, { allocationGeneration: 9, paneLabel: 2 });
  } finally {
    await connection.stop();
    await central.close();
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
    central.reply(0);
    await until(() => central.requests.length === 2);
    central.reply(1, true, true, 700, undefined, undefined, {
      windowGenerationV1: true, completedWindowReleaseIds: [],
    });
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
  const configured = await centralFixture(null);
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
    assert.equal(status(), "connecting");
    await until(() => fallback.requests.length === 1);
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
    assert.equal(status(), "connecting");
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
  const registry = await automaticRegistryFixture();
  const clientId = "e".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Fresh", { width: 800, height: 600, scale: 1 });
  const pane = [...surface.panes.values()][0]!;
  const writes: ReturnType<typeof core.getPersistentState>[] = [];
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core,
    async () => { writes.push(core.getPersistentState()); }, () => {}, 500);
  try {
    await registration.synchronize();
    const request = registry.requests[0]!.message.payload;
    assert.equal(request.surfaces[0]!.surfaceId, surface.surfaceId);
    assert.equal(request.surfaces[0]!.windowGeneration, null);
    assert.equal(request.surfaces[0]!.panes[0]!.paneId, String(pane.paneId));
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
    assert.equal(core.registryBindingPending(), false);
    assert.equal(core.getRendererWindowState(surface.surfaceId).windowLabel, "a");
    assert.equal(core.panesList(surface.surfaceId).panes[0]?.paneLabel, 700);
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

test("unreadable pane records do not discard readable panes from the saved window", () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Partial restore", { width: 800, height: 600, scale: 1 });
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

test("a matching discovered registry wins over an earlier foreign server advertisement", async () => {
  const clientId = "f".repeat(64);
  const core = new SurfaceCore({ clientIdentity: clientId });
  const surface = core.ensurePrimarySurface("Bound display", { width: 800, height: 600, scale: 1 });
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
    const history = core.getPersistentState().registryBindingHistory!;
    assert.ok(history.some((entry) => entry.heldWindowReleaseIds.includes(oldRelease.releaseId)));
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

test("automatic rebinding does not return to a previously abandoned registry", async () => {
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
  const connection = new ServerConnection({ clientId, core, persist: async () => {}, discovery, requestTimeoutMs: 500 });
  let newRegistryClosed = false;
  try {
    await connection.synchronize();
    assert.deepEqual(core.registryBinding(), { clientId, allocatorId: "alloc_new", fleetId: "fleet-new" });
    await newRegistry.close();
    newRegistryClosed = true;
    discovery.getSnapshot = () => [oldRegistry.endpoint];

    await assert.rejects(connection.synchronize(), /no_surf_ace_server/);

    assert.deepEqual(core.registryBinding(), { clientId, allocatorId: "alloc_new", fleetId: "fleet-new" });
    assert.equal(oldRegistry.requests.length, 0);
    assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.content.contentId, "ct_rebind_again");
  } finally {
    await connection.stop();
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
  const tombstone = core.locklessAuthority.createTombstone({
    kind: "pane",
    payload: { closeTopologyRevision: 5, pane: {
      allocationGeneration: 7, paneId: 9, paneLabel: 709, paneLineageId: "pl_refused_release",
    } },
    surfaceId: surface.surfaceId,
  });
  const release = core.locklessAuthority.listPendingPaneReleases()[0]!;
  assert.ok(tombstone.tombstoneId);
  const registry = await automaticRegistryFixture({ rejectReleaseIds: new Set([release.releaseId]) });
  const registration = new ConfiguredServerRegistration(registry.address, clientId, core, async () => {}, () => {}, 500);
  try {
    await registration.synchronize();
    const attempts = registry.requests.filter((request) =>
      request.message.payload.pendingPaneReleases.some((item: any) => item.releaseId === release.releaseId));
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((request) => request.message.payload.pendingPaneReleases[0]), [release, release]);
    assert.equal(core.locklessAuthority.listPendingPaneReleases().length, 0);
    assert.ok(core.getPersistentState().lockless!.paneRetirementAudits.some((entry) => entry.releaseId === release.releaseId));
    assert.equal(core.getRendererWindowState(surface.surfaceId).connectionBar, "disconnected");
    assert.equal(core.getRendererWindowState(surface.surfaceId).panes.length, 1);
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
    assert.equal(restoredState.windowLabel, null);
    assert.equal(restoredState.panes[0]?.label, null);
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
  const connection = new ConfiguredServerRegistration(registry.address, "fresh-client", core,
    async () => { throw new Error("binding_write_interrupted"); }, () => {}, 200);
  try {
    await assert.rejects(connection.synchronize(), /binding_write_interrupted/);
    assert.equal(registry.identityRequests.length, 1);
    assert.equal(registry.requests.length, 0);
    assert.equal(core.registryBinding(), null);
    assert.deepEqual(core.getPersistentState(), before);
    assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.content.contentId, "ct_registry_bind");
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
  core.ensurePrimarySurface("Uncertain binding", { width: 800, height: 600, scale: 1 });
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
  } finally {
    await registration.stop();
    await registry.close();
  }
});
