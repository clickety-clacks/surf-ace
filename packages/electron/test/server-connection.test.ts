import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { ServerConnection } from "../src/server-connection.js";
import { ConfiguredServerRegistration } from "../src/configured-server.js";
import { SurfaceCore } from "../src/surface-core.js";

test("Bonjour transport address avoids slow hostname resolution and retains hostname fallback", async () => {
  const original = ConfiguredServerRegistration.prototype.synchronize;
  const originalStop = ConfiguredServerRegistration.prototype.stop;
  try {
    for (const code of [undefined, "ECONNREFUSED", "registration_failed"]) {
      const attempted: string[] = [];
      ConfiguredServerRegistration.prototype.synchronize = async function () {
        const url = (this as any).wire.url as string;
        attempted.push(url);
        if (url.includes("192.0.2.10") && code) throw Object.assign(new Error(code), { code });
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
    reply(index: number, ok = true, assignPaneLabels = true, paneLabelBase = 700, windowLabel?: string) {
      const { socket, message } = requests[index]!;
      assert.equal(message.op, "client.register");
      socket.send(JSON.stringify({
        type: "response", id: message.id, op: message.op, ok,
        payload: { clientId: message.payload.clientId,
          surfaces: message.payload.surfaces.map((surface: any, i: number) => ({
            surfaceId: surface.surfaceId,
            windowLabel: windowLabel ?? String.fromCharCode(97 + i),
            ...(assignPaneLabels ? {
              panes: (surface.panes ?? []).map((pane: any, paneIndex: number) => ({
                ...pane, paneLabel: paneLabelBase + i * 100 + paneIndex,
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

test("configured rejection falls back through Bonjour and absent central stays disconnected", async () => {
  const configured = await centralFixture();
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
    await until(() => configured.requests.length === 1);
    assert.equal(status(), "connecting");
    configured.reply(0, false);
    await until(() => fallback.requests.length === 1);
    assert.equal(status(), "connecting");
    fallback.reply(0);
    await attempt;
    assert.equal(status(), "connected");
    // Failed configured recovery must not flicker a healthy fallback indicator.
    const recovery = connection.synchronize();
    await until(() => fallback.requests.length === 2);
    fallback.reply(1);
    await until(() => configured.requests.length === 2);
    assert.equal(status(), "connected");
    configured.reply(1, false);
    await recovery;
    assert.equal(status(), "connected");
    advertised = false;
    await fallback.close();
    await until(() => status() === "disconnected");
    const retry = connection.synchronize();
    const rejected = assert.rejects(retry, /no_surf_ace_server/);
    await until(() => configured.requests.length === 3);
    assert.equal(status(), "connecting");
    configured.reply(2, false);
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
  discovery.getSnapshot = () => [{
    host: "127.0.0.1", port: central.port, wsPath: "/ws", protocolVersion: 1,
    role: "server", instanceName: "test registry", transportAddresses: ["127.0.0.1"],
  } as any];
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
      assert.equal(request.message.payload.surfaces[0]!.panes[0]!.paneLineageId, paneLineageId);
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

test("legacy labels wait for verified pin; foreign and missing identities never register", async () => {
  const correct = await centralFixture({ allocatorId: "alloc_home", fleetId: "fleet-home" });
  const moved = await centralFixture({ allocatorId: "alloc_home", fleetId: "fleet-home" });
  const foreign = await centralFixture({ allocatorId: "alloc_foreign", fleetId: "fleet-foreign" });
  const missing = await centralFixture(null);
  const clientId = "legacy-client";
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Preserved display", { width: 800, height: 600, scale: 1 });
  const pane = [...surface.panes.values()][0]!;
  const assignment = [{
    surfaceId: surface.surfaceId, windowLabel: "d", panes: [{
      paneId: String(pane.paneId), paneLineageId: pane.paneLineageId, paneLabel: 703,
    }],
  }];
  core.applyWindowLabels(assignment);
  core.applyRegistryPaneLabels(assignment);
  const before = core.getPersistentState();
  const provisionedBinding = {
    binding: { clientId, allocatorId: "alloc_home", fleetId: "fleet-home" },
    confirmedClaims: core.confirmedRegistryClaims(),
  };
  const attempt = async (address: string, provisioned = provisionedBinding) => {
    const connection = new ConfiguredServerRegistration(address, clientId, core, async () => {}, () => {}, 200, provisioned);
    try { await connection.synchronize(); } finally { await connection.stop(); }
  };
  try {
    await assert.rejects(attempt(foreign.address, null), /legacy_registry_binding_pending/);
    await assert.rejects(attempt(foreign.address), /foreign_registry_identity/);
    await assert.rejects(attempt(missing.address), /registry_identity_missing_or_invalid/);
    assert.equal(foreign.requests.length, 0);
    assert.equal(missing.requests.length, 0);
    assert.deepEqual(core.getPersistentState(), before);

    const connecting = attempt(correct.address);
    await until(() => correct.requests.length === 1);
    correct.reply(0, true, true, 703, "d");
    await connecting;
    assert.deepEqual(core.registryBinding(), provisionedBinding.binding);
    assert.equal(core.panesList(surface.surfaceId).panes[0]?.paneLabel, 703);
    assert.equal(core.getRendererWindowState(surface.surfaceId).windowLabel, "d");
    const pinnedState = core.getPersistentState();
    const restored = new SurfaceCore({ persistentState: pinnedState });
    restored.restorePersistedSurfaces("Restored", { width: 800, height: 600, scale: 1 });
    const replay = new ConfiguredServerRegistration(foreign.address, clientId, restored, async () => {}, () => {}, 200);
    try {
      await assert.rejects(replay.synchronize(), /foreign_registry_identity/);
    } finally { await replay.stop(); }
    assert.equal(foreign.requests.length, 0);
    assert.deepEqual(restored.registryBinding(), provisionedBinding.binding);
    const sameFleet = new ConfiguredServerRegistration(moved.address, clientId, restored, async () => {}, () => {}, 200);
    try {
      const reconnecting = sameFleet.synchronize();
      await until(() => moved.requests.length === 1);
      moved.reply(0, true, true, 703, "d");
      await reconnecting;
      assert.deepEqual(restored.registryBinding(), provisionedBinding.binding);
      assert.equal(restored.panesList(surface.surfaceId).panes[0]?.paneLabel, 703);
    } finally { await sameFleet.stop(); }
  } finally {
    await correct.close();
    await moved.close();
    await foreign.close();
    await missing.close();
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
