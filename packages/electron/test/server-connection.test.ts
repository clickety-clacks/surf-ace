import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { ServerConnection } from "../src/server-connection.js";
import { ConfiguredServerRegistration } from "../src/configured-server.js";
import { SurfaceCore } from "../src/surface-core.js";

test("Bonjour transport fallback is limited to hostname resolution failures", async () => {
  const original = ConfiguredServerRegistration.prototype.synchronize;
  const originalStop = ConfiguredServerRegistration.prototype.stop;
  try {
    for (const code of [undefined, "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "registration_failed"]) {
      const attempted: string[] = [];
      ConfiguredServerRegistration.prototype.synchronize = async function () {
        const url = (this as any).wire.url as string;
        attempted.push(url);
        if (url.includes("stable.local") && code) throw Object.assign(new Error(code), { code });
      };
      ConfiguredServerRegistration.prototype.stop = async () => {};
      const endpoint = {
        host: "stable.local", endpointId: "stable.local:19430/#stable", port: 19430,
        wsPath: "/", role: "server", transportAddresses: ["192.0.2.10"],
      } as any;
      const connection = new ServerConnection({
        clientId: "fixture", core: new SurfaceCore(), persist: async () => {},
        discovery: {
          start: async () => {}, stop: async () => {}, refreshNow: async () => {},
          subscribe: () => () => {}, getSnapshot: () => [endpoint],
        },
      });
      if (code === "ECONNREFUSED" || code === "registration_failed") {
        await assert.rejects(connection.synchronize(), /no_surf_ace_server/);
      } else {
        await connection.synchronize();
      }
      assert.deepEqual(attempted, code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? ["ws://stable.local:19430/", "ws://192.0.2.10:19430/"]
        : ["ws://stable.local:19430/"]);
      assert.equal(endpoint.host, "stable.local");
      assert.equal(endpoint.endpointId, "stable.local:19430/#stable");
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

async function centralFixture() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const requests: Array<{ socket: WebSocket; message: any }> = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw) => requests.push({ socket, message: JSON.parse(String(raw)) }));
  });
  return {
    server, requests, port, address: `ws://127.0.0.1:${port}/`,
    reply(index: number, ok = true) {
      const { socket, message } = requests[index]!;
      assert.equal(message.op, "client.register");
      socket.send(JSON.stringify({
        type: "response", id: message.id, op: message.op, ok,
        payload: { clientId: message.payload.clientId,
          surfaces: message.payload.surfaces.map((surface: any, i: number) => ({
            surfaceId: surface.surfaceId, windowLabel: String.fromCharCode(97 + i),
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
  const panes = structuredClone(core.getRendererWindowState(surface.surfaceId).panes);
  const persisted = deferred();
  const persistStarted = deferred();
  let blockPersistence = true;
  const connection = new ServerConnection({
    configuredAddress: central.address, clientId: "status-client", core,
    discovery: emptyDiscovery(), requestTimeoutMs: 500,
    persist: async () => { if (blockPersistence) { persistStarted.resolve(); await persisted.promise; } },
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
    assert.deepEqual(state().panes, panes);
    central.requests[0]!.socket.terminate();
    await until(() => state().connectionBar === "disconnected");
    const reconnect = connection.synchronize();
    await until(() => central.requests.length === 2);
    assert.equal(state().connectionBar, "connecting");
    central.reply(1);
    await reconnect;
    assert.equal(state().connectionBar, "connected");
    assert.deepEqual(central.requests[1]!.message.payload, central.requests[0]!.message.payload);
    assert.deepEqual(state().panes, panes);
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
    host: "127.0.0.1", port: fallback.port, wsPath: "/", role: "server",
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

test("central closure while registration persists cannot publish connected", async () => {
  const central = await centralFixture();
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Closed", { width: 800, height: 600, scale: 1 });
  const entered = deferred();
  const release = deferred();
  const connection = new ServerConnection({
    configuredAddress: central.address, clientId: "closed-client", core,
    discovery: emptyDiscovery(), persist: async () => { entered.resolve(); await release.promise; },
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
