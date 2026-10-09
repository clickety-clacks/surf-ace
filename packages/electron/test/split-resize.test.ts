import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writePersistentStateFile, loadPersistentStateFile, PersistentStateOutcomeUnknownError } from "../src/persistent-state-file.js";
import { splitResizeMatches, splitResizeIsNoOp } from "../src/split-resize.js";
import { SurfaceCore } from "../src/surface-core.js";
import { SurfaceWsServer } from "../src/ws-server.js";

async function stopUnstartedServer(server: SurfaceWsServer): Promise<void> {
  try { await server.stop(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error;
  }
}

function fixture(persist?: (core: SurfaceCore) => Promise<void>, nativeNotification?: () => void) {
  const core = new SurfaceCore();
  const { surfaceId } = core.ensurePrimarySurface("isolated resize", { width: 1200, height: 800, scale: 1 });
  core.resetProviderBootstrapTopology(surfaceId, { initialPaneId: 1, initialPaneLabel: 1, windowLabel: "a" });
  core.paneSplit(surfaceId, { paneId: 1, count: 2, direction: "vertical", newPaneIds: [2], newPaneLabels: [2] });
  const server = new SurfaceWsServer({ core, port: 0, bindAddress: "127.0.0.1", compositorSocketPath: null,
    persistLocklessState: persist ? () => persist(core) : undefined, onNativeMaterialized: nativeNotification,
    endpointName: "private", hostName: "private", capturePaneImage: async () => null,
    viewport: () => ({ width: 1200, height: 800, scale: 1 }) });
  // Never call start(): no HTTP/WebSocket listener, discovery, compositor or process.
  const expected = core.getRendererWindowState(surfaceId);
  const resolveGeometry = () => {
    for (const paneId of core.activePaneIds(surfaceId)) core.updatePaneSnapshot(surfaceId, paneId, {
      ...core.resolvedPaneGeometryIdentity(surfaceId), bounds: { x: 0, y: 0, width: 600, height: 800 },
    });
  };
  const geometry = core.activePaneIds(surfaceId).map((paneId, i) => ({ paneId, bounds: { x: i * 600, y: 0, width: 600, height: 800 } }));
  return { core, surfaceId, server, expected, resolveGeometry, geometry };
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
  const { core, surfaceId, server, expected, geometry } = fixture();
  const events: string[] = [];
  const unsubscribe = core.subscribe((event) => { events.push(event.type); });
  try {
    const first = server.resizeSplit(surfaceId, [], [3, 1], expected, geometry);
    const staleSecond = server.resizeSplit(surfaceId, [], [1, 3], expected);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(await first, true);
    assert.equal(await staleSecond, false);
    const actual = core.getRendererWindowState(surfaceId);
    assert.equal(actual.topologyRevision, expected.topologyRevision + 1);
    assert.equal(actual.layout?.type, "split");
    if (actual.layout?.type === "split") assert.deepEqual(actual.layout.children.map((child) => child.weight), [3, 1]);
    assert.equal(events.filter((event) => event === "topology-changed").length, 1);
  } finally { unsubscribe(); await stopUnstartedServer(server); }
});


test("acknowledged resize publishes and saves only accepted geometry; definite failures conserve committed state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-resize-commit-"));
  let rejectSave = false;
  const f = fixture(async (core) => {
    if (rejectSave) throw new Error("definite save failure");
    await writePersistentStateFile(dir, "state.json", core.getPersistentState());
  });
  const { core, surfaceId, server, expected, geometry } = f;
  const initial = core.getPersistentState();
  await writePersistentStateFile(dir, "state.json", initial);
  let rendererReadback = core.getRendererWindowState(surfaceId);
  const events: string[] = [];
  const subscriberWrites: Promise<void>[] = [];
  let writeTail = Promise.resolve();
  const unsubscribe = core.subscribe((event) => {
    events.push(event.type);
    if (event.type === "surface-changed") {
      rendererReadback = core.getRendererWindowState(surfaceId);
      const captured = core.getPersistentState();
      writeTail = writeTail.then(() => writePersistentStateFile(dir, "state.json", captured));
      subscriberWrites.push(writeTail);
    }
  });
  const seam = server as unknown as { applyResolvedNativePaneGeometry: (...args: unknown[]) => Promise<void> };
  const originalApply = seam.applyResolvedNativePaneGeometry;
  let prospectiveRevision = 0;
  seam.applyResolvedNativePaneGeometry = async () => {
    prospectiveRevision = core.getRendererWindowState(surfaceId).topologyRevision;
    assert.equal(events.length, 0, "candidate has not reached real subscribers");
    throw new Error("injected materialization rejection");
  };
  try {
    assert.equal(await server.resizeSplit(surfaceId, [], [3, 1], expected, geometry), false);
    assert.equal(prospectiveRevision, expected.topologyRevision + 1);
    assert.deepEqual(core.getPersistentState(), initial);
    assert.deepEqual(rendererReadback, expected);
    assert.deepEqual(events, []);
    const restored = await loadPersistentStateFile(dir, "state.json");
    assert.equal(restored.writeGuard, false);
    assert.deepEqual(restored.state, initial);
    seam.applyResolvedNativePaneGeometry = originalApply;
    rejectSave = true;
    assert.equal(await server.resizeSplit(surfaceId, [], [3, 1], expected, geometry), false);
    assert.deepEqual(core.getPersistentState(), initial);
    assert.deepEqual(rendererReadback, expected);
    assert.deepEqual(events, []);
    rejectSave = false;
    assert.equal(await server.resizeSplit(surfaceId, [], [3, 1], expected, geometry), true);
    await Promise.all(subscriberWrites);
    assert.equal(rendererReadback.topologyRevision, expected.topologyRevision + 1);
    assert.equal(events.filter((type) => type === "topology-changed").length, 1);
    const saved = await loadPersistentStateFile(dir, "state.json");
    assert.equal(saved.writeGuard, false);
    assert.deepEqual(saved.state, core.getPersistentState());
    const reloaded = new SurfaceCore({ persistentState: saved.state });
    reloaded.restorePersistedSurfaces("isolated reload", { width: 1200, height: 800, scale: 1 });
    assert.deepEqual(reloaded.getRendererWindowState(surfaceId).layout, rendererReadback.layout);
    assert.equal(reloaded.getRendererWindowState(surfaceId).topologyRevision, rendererReadback.topologyRevision);
  } finally { unsubscribe(); await stopUnstartedServer(server); await fs.rm(dir, { recursive: true, force: true }); }
});

test("uncertain resize persistence keeps fenced candidate without committed event or successful ack", async () => {
  const { core, surfaceId, server, expected, geometry } = fixture(async () => { throw new PersistentStateOutcomeUnknownError(new Error("selector uncertain")); });
  const events: string[] = [];
  const unsubscribe = core.subscribe((event) => { events.push(event.type); });
  try {
    assert.equal(await server.resizeSplit(surfaceId, [], [3, 1], expected, geometry), false);
    assert.equal(core.getRendererWindowState(surfaceId).topologyRevision, expected.topologyRevision + 1);
    assert.deepEqual(events, []);
    assert.equal(await server.resizeSplit(surfaceId, [], [1, 3], expected, geometry), false);
  } finally { unsubscribe(); await stopUnstartedServer(server); }
});


test("acknowledged resize rejects incomplete, duplicate and nonfinite geometry before publication", async () => {
  const { core, surfaceId, server, expected, geometry } = fixture();
  const before = core.getPersistentState();
  const events: string[] = [];
  const unsubscribe = core.subscribe((event) => { events.push(event.type); });
  try {
    for (const candidate of [undefined, geometry.slice(0, 1), [geometry[0]!, geometry[0]!],
      geometry.map((entry) => ({ ...entry, bounds: { ...entry.bounds, width: NaN } }))]) {
      assert.equal(await server.resizeSplit(surfaceId, [], [3, 1], expected, candidate), false);
      assert.deepEqual(core.getPersistentState(), before);
      assert.deepEqual(events, []);
    }
  } finally { unsubscribe(); await stopUnstartedServer(server); }
});


test("durable resize survives post-save native callback and subscriber exceptions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-resize-postsave-"));
  const { core, surfaceId, server, resolveGeometry, geometry } = fixture(async (core) => {
    await writePersistentStateFile(dir, "state.json", core.getPersistentState());
  }, () => { throw new Error("post-save native callback failed"); });
  resolveGeometry();
  const pane = core.panesList(surfaceId).panes[0]!;
  core.markNativePaneMaterialized(surfaceId, { focus: core.projectNativePaneFocus(surfaceId), op: "native_pane.host", panes: [{
    id: String(pane.paneId), binding_id: "private-binding", content_id: "private-content", revision: 1 as never, target: "terminal",
    process: { command: "never-launched", args: [] }, geometry: { coordinateSpace: "compositor_logical",
      ...pane.geometry.contentViewport, geometryRevision: pane.geometry.geometryRevision, paneInstanceId: pane.geometry.paneInstanceId,
      surfaceEpoch: pane.geometry.surfaceEpoch, topologyEpoch: pane.geometry.topologyEpoch },
  }] });
  const expected = core.getRendererWindowState(surfaceId);
  const seam = server as unknown as { applyResolvedNativePaneGeometry: (...args: unknown[]) => Promise<void>; rollbackNativePaneGeometry: (...args: unknown[]) => Promise<void> };
  // Inject native transport only; real projection/validation/bookkeeping still runs.
  seam.applyResolvedNativePaneGeometry = async () => {};
  let rollbacks = 0;
  seam.rollbackNativePaneGeometry = async () => { rollbacks++; };
  const badSubscriber = core.subscribe(() => { throw new Error("post-save subscriber failed"); });
  const events: string[] = [];
  let rendererReadback = expected;
  const goodSubscriber = core.subscribe((event) => {
    events.push(event.type);
    if (event.type === "surface-changed") rendererReadback = core.getRendererWindowState(surfaceId);
  });
  try {
    assert.equal(await server.resizeSplit(surfaceId, [], [3, 1], expected, geometry), true);
    assert.equal(rollbacks, 0);
    assert.equal(rendererReadback.topologyRevision, expected.topologyRevision + 1);
    assert.equal(events.filter((type) => type === "topology-changed").length, 1);
    const loaded = await loadPersistentStateFile(dir, "state.json");
    assert.equal(loaded.writeGuard, false);
    assert.deepEqual(loaded.state, core.getPersistentState());
    const restored = new SurfaceCore({ persistentState: loaded.state });
    restored.restorePersistedSurfaces("reload", { width: 1200, height: 800, scale: 1 });
    assert.deepEqual(restored.getRendererWindowState(surfaceId).layout, rendererReadback.layout);
  } finally { badSubscriber(); goodSubscriber(); await stopUnstartedServer(server); await fs.rm(dir, { recursive: true, force: true }); }
});

test("uncertain save reconciliation publishes captured topology once and fresh retries have no native effects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-resize-reconcile-"));
  const { core, surfaceId, server, expected, geometry } = fixture(async () => { throw new PersistentStateOutcomeUnknownError(new Error("selector uncertain")); });
  let nativeApplications = 0;
  const seam = server as unknown as { applyResolvedNativePaneGeometry: (...args: unknown[]) => Promise<void> };
  seam.applyResolvedNativePaneGeometry = async () => { nativeApplications++; };
  const topologies: unknown[] = [];
  const unsubscribe = core.subscribe((event) => { if (event.type === "topology-changed") topologies.push(event.topology); });
  try {
    assert.equal(await server.resizeSplit(surfaceId, [], [3, 1], expected, geometry), false);
    const candidate = core.getPersistentState();
    const fresh = core.getRendererWindowState(surfaceId);
    assert.equal(await server.resizeSplit(surfaceId, [], [1, 3], fresh, geometry), false);
    assert.equal(nativeApplications, 1, "fresh expectation is fenced before materialization");
    assert.deepEqual(core.getPersistentState(), candidate);
    assert.deepEqual(topologies, []);
    await writePersistentStateFile(dir, "state.json", candidate);
    const loaded = await loadPersistentStateFile(dir, "state.json");
    assert.equal(loaded.writeGuard, false);
    assert.ok(loaded.state);
    server.resumeAfterVerifiedPersistence();
    assert.equal(core.publishVerifiedTransactionEvents(loaded.state, () => {}), true);
    assert.equal(core.publishVerifiedTransactionEvents(loaded.state, () => {}), false);
    assert.equal(topologies.length, 1);
    assert.deepEqual(topologies[0], core.publicTopologyState(surfaceId));
  } finally { unsubscribe(); await stopUnstartedServer(server); await fs.rm(dir, { recursive: true, force: true }); }
});

test("held core transaction, network-equivalent mutation and same-surface renderer resize settle without queue inversion", async () => {
  const { core, surfaceId, server, expected, geometry } = fixture();
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const earlier = core.transactionAsync(async () => { started(); await barrier; });
  await entered;
  const seam = server as unknown as { runSurfaceMutation: <T>(id: string, op: () => T) => Promise<T> };
  const network = core.transactionAsync(() => seam.runSurfaceMutation(surfaceId, () => {
    core.paneSplit(surfaceId, { paneId: 1, count: 2, direction: "horizontal", newPaneIds: [3], newPaneLabels: [3] });
    return true;
  }));
  const resize = server.resizeSplit(surfaceId, [], [3, 1], expected, geometry);
  await Promise.resolve();
  release();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([Promise.all([earlier, network, resize]), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("queue inversion blocked both legitimate operations")), 1000);
    })]);
    assert.equal(result[1], true);
    assert.equal(result[2], false, "resize revalidates after legitimate network topology change");
    assert.deepEqual(core.activePaneIds(surfaceId).sort(), [1, 2, 3]);
    assert.equal(core.getRendererWindowState(surfaceId).topologyRevision, expected.topologyRevision + 1);
  } finally { clearTimeout(timeout); release(); await stopUnstartedServer(server); }
});
