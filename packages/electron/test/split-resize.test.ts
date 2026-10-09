import assert from "node:assert/strict";
import test from "node:test";
import { splitResizeMatches, splitResizeIsNoOp } from "../src/split-resize.js";
import { SurfaceCore } from "../src/surface-core.js";
import { SurfaceWsServer } from "../src/ws-server.js";

async function stopUnstartedServer(server: SurfaceWsServer): Promise<void> {
  try { await server.stop(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error;
  }
}

function fixture() {
  const core = new SurfaceCore();
  const { surfaceId } = core.ensurePrimarySurface("isolated resize", { width: 1200, height: 800, scale: 1 });
  core.resetProviderBootstrapTopology(surfaceId, { initialPaneId: 1, initialPaneLabel: 1, windowLabel: "a" });
  core.paneSplit(surfaceId, { paneId: 1, count: 2, direction: "vertical", newPaneIds: [2], newPaneLabels: [2] });
  const server = new SurfaceWsServer({ core, port: 0, bindAddress: "127.0.0.1", compositorSocketPath: null,
    endpointName: "private", hostName: "private", capturePaneImage: async () => null,
    viewport: () => ({ width: 1200, height: 800, scale: 1 }) });
  // Never call start(): no HTTP/WebSocket listener, discovery, compositor or process.
  const expected = core.getRendererWindowState(surfaceId);
  const resolveGeometry = () => {
    for (const paneId of core.activePaneIds(surfaceId)) core.updatePaneSnapshot(surfaceId, paneId, {
      ...core.resolvedPaneGeometryIdentity(surfaceId), bounds: { x: 0, y: 0, width: 600, height: 800 },
    });
  };
  return { core, surfaceId, server, expected, resolveGeometry };
}

test("resize expectation fences epoch, revision and exact targeted tree", () => {
  const current = { surfaceEpoch: "a", topologyRevision: 2, geometryRevision: 4,
    layout: { type: "split", children: [{ type: "pane", paneId: 1 }, { type: "pane", paneId: 2 }] } };
  assert.equal(splitResizeMatches(current, structuredClone(current)), true);
  for (const expected of [ { ...current, surfaceEpoch: "b" }, { ...current, topologyRevision: 1 }, { ...current, geometryRevision: 3 },
    { ...current, layout: { ...current.layout, children: [...current.layout.children].reverse() } } ]) {
    assert.equal(splitResizeMatches(current, expected), false);
  }
});

test("normalized no-op weights and nested target do not need a mutation", () => {
  const pair = { type: "split", children: [{ type: "pane", weight: 3 }, { type: "pane", weight: 1 }] };
  assert.equal(splitResizeIsNoOp(pair, [], [6, 2]), true);
  assert.equal(splitResizeIsNoOp({ type: "split", children: [pair] }, [0], [3, 1]), true);
  for (const weights of [[1, 1], [0, 1], [Infinity, 1], [NaN, 1], [3], [1e308, 1e308]]) {
    assert.equal(splitResizeIsNoOp(pair, [], weights), false);
  }
});

test("no-op and stale resize commit preserve topology, content and event count", async () => {
  const { core, surfaceId, server, expected } = fixture();
  const saved = core.getPersistentState();
  const events: string[] = [];
  const unsubscribe = core.subscribe((event) => { events.push(event.type); });
  try {
    assert.equal(await server.resizeSplit(surfaceId, [], [2, 2], expected), true);
    assert.equal(await server.resizeSplit(surfaceId, [], [3, 1], { ...expected, topologyRevision: 0 }), false);
    assert.deepEqual(core.getPersistentState(), saved);
    assert.deepEqual(events, []);
  } finally { unsubscribe(); await stopUnstartedServer(server); }
});

test("queued resize revalidates at authority after earlier completed mutation", async () => {
  const { core, surfaceId, server, expected, resolveGeometry } = fixture();
  const events: string[] = [];
  const unsubscribe = core.subscribe((event) => { events.push(event.type); });
  try {
    const first = server.resizeSplit(surfaceId, [], [3, 1], expected);
    const staleSecond = server.resizeSplit(surfaceId, [], [1, 3], expected);
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveGeometry();
    assert.equal(await first, true);
    assert.equal(await staleSecond, false);
    const actual = core.getRendererWindowState(surfaceId);
    assert.equal(actual.topologyRevision, expected.topologyRevision + 1);
    assert.equal(actual.layout?.type, "split");
    if (actual.layout?.type === "split") assert.deepEqual(actual.layout.children.map((child) => child.weight), [3, 1]);
    assert.equal(events.filter((event) => event === "topology-changed").length, 1);
  } finally { unsubscribe(); await stopUnstartedServer(server); }
});
