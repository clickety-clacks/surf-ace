import assert from "node:assert/strict";
import test from "node:test";

import { AnnotationSourceCoordinator } from "../src/annotation-source-coordinator.js";
import { SurfaceCore } from "../src/surface-core.js";
import { SurfaceWsServer } from "../src/ws-server.js";

const clientId = "c".repeat(64);
const viewport = { width: 640, height: 480, scale: 1 };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";

test("Done still completes the direct frame when registry publishing is not configured", { timeout: 5_000 }, async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  core.admitSurfaceToLockless(surface.surfaceId);
  const paneId = core.activePaneIds(surface.surfaceId)[0]!;
  core.locklessContentPush(surface.surfaceId, {
    content: { markdown: "direct-only" }, contentId: "direct-only",
    contentType: "markdown", friendlyChatName: "Direct", paneId,
  }, "Direct");
  let completed = (): void => {};
  const completion = new Promise<void>((resolve) => { completed = resolve; });
  let sawPendingCommit = false;
  const persist = async () => {
    if (core.hasPendingAnnotationCommit(surface.surfaceId, paneId)) sawPendingCommit = true;
    if (sawPendingCommit && !core.hasPendingAnnotationCommit(surface.surfaceId, paneId)) completed();
  };
  const server = new SurfaceWsServer({
    bindAddress: "127.0.0.1", capturePaneImage: async () => png,
    compositorSocketPath: null, core, endpointName: "Surf Ace", hostName: "localhost",
    persistLocklessState: persist, port: 0, viewport: () => viewport,
  });
  server.setAnnotationCompletionManaged((surfaceId, id) =>
    core.annotationPublisher?.openFrameFor(surfaceId, id) != null);
  const source = new AnnotationSourceCoordinator(core, persist, () => {}, (error) => { throw error; },
    (surfaceId, id) => server.completeDirectAnnotation(surfaceId, id));
  assert.equal(core.annotationPublisher, null);
  await source.setAnnotating(surface.surfaceId, paneId, true);
  core.addStroke(surface.surfaceId, paneId, {
    strokeId: "direct-stroke" as never, tool: "mouse",
    points: [{ x: 1, y: 2, timestamp: 1 }],
  });
  await source.setAnnotating(surface.surfaceId, paneId, false);
  await completion;
  assert.equal(core.hasPendingAnnotationCommit(surface.surfaceId, paneId), false);
  assert.ok(Object.values(core.getPersistentState().lockless?.scopes ?? {}).some((scope) =>
    scope.records.some((record) => record.recordClass === "annotation_frame")));
  source.stop();
});

test("new annotation entry discards an orphaned at-open capture before a new context", async () => {
  const core = new SurfaceCore({ annotationClientId: clientId });
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  core.admitSurfaceToLockless(surface.surfaceId);
  const paneId = core.activePaneIds(surface.surfaceId)[0]!;
  core.locklessContentPush(surface.surfaceId, {
    content: { markdown: "old" }, contentId: "old-content",
    contentType: "markdown", friendlyChatName: "Old", paneId,
  }, "Old");
  const outbox = core.annotationPublisher!;
  const orphan = outbox.openFrame(surface.surfaceId, paneId, {
    contentId: "old-content", contextKey: "old-content", image: png,
    openedAt: 1, scrollOffset: { x: 0, y: 0 }, viewport,
  });
  outbox.recordStroke(surface.surfaceId, paneId, {
    strokeId: "old-stroke" as never, tool: "mouse", points: [{ x: 1, y: 2, timestamp: 2 }],
  });
  core.locklessContentPush(surface.surfaceId, {
    content: { markdown: "new" }, contentId: "new-content",
    contentType: "markdown", friendlyChatName: "New", paneId,
  }, "New");
  let durable = core.getPersistentState();
  const source = new AnnotationSourceCoordinator(core, async () => {
    durable = core.getPersistentState();
  }, () => {}, (error) => { throw error; });
  await source.setAnnotating(surface.surfaceId, paneId, true);
  assert.equal(outbox.openFrameFor(surface.surfaceId, paneId), null);
  assert.equal(JSON.parse(outbox.head(surface.surfaceId)!.canonical).reason, "source_retention_overflow");
  const fresh = outbox.openFrame(surface.surfaceId, paneId, {
    contentId: "new-content", contextKey: "new-content", image: png,
    openedAt: 3, scrollOffset: { x: 0, y: 0 }, viewport,
  });
  assert.notEqual(fresh.frameId, orphan.frameId);
  assert.equal(durable.annotationPublisher?.surfaces[surface.surfaceId]?.openFrames?.[String(paneId)] ?? null, null);
  source.stop();
});

test("same-context reentry during final flush keeps one frame and defeats stale completion", { timeout: 5_000 }, async () => {
  const core = new SurfaceCore({ annotationClientId: clientId });
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  core.admitSurfaceToLockless(surface.surfaceId);
  const paneId = core.activePaneIds(surface.surfaceId)[0]!;
  core.locklessContentPush(surface.surfaceId, {
    content: { markdown: "same context" }, contentId: "same-content",
    contentType: "markdown", friendlyChatName: "Same", paneId,
  }, "Same");
  let reachedFlush = (): void => {};
  const flushing = new Promise<void>((resolve) => { reachedFlush = resolve; });
  let releaseFlush = (): void => {};
  const released = new Promise<void>((resolve) => { releaseFlush = resolve; });
  let holdFlush = true;
  let directCommits = 0;
  const source = new AnnotationSourceCoordinator(core, async () => {
    if (holdFlush && core.annotationPublisher!.snapshot().surfaces[surface.surfaceId]?.fifo.some(
      (entry) => JSON.parse(entry.canonical).kind === "live_delta")) {
      holdFlush = false;
      reachedFlush();
      await released;
    }
  }, () => {}, (error) => { throw error; }, async () => {
    directCommits += 1;
    core.markDrawingFlushSent(surface.surfaceId, paneId);
    core.markAnnotationCommittedSent(surface.surfaceId, paneId);
    return true;
  });
  await source.setAnnotating(surface.surfaceId, paneId, true);
  const opened = core.annotationPublisher!.openFrame(surface.surfaceId, paneId, {
    contentId: "same-content", contextKey: "same-content", image: png,
    openedAt: 100, scrollOffset: { x: 0, y: 0 }, viewport,
  });
  core.addStroke(surface.surfaceId, paneId, {
    strokeId: "first" as never, tool: "mouse", points: [{ x: 1, y: 2, timestamp: 110 }],
  });
  const staleDone = source.setAnnotating(surface.surfaceId, paneId, false);
  await flushing;
  const reentry = source.setAnnotating(surface.surfaceId, paneId, true);
  releaseFlush();
  await Promise.all([staleDone, reentry]);
  assert.equal(directCommits, 0);
  assert.equal(core.annotationPublisher!.openFrameFor(surface.surfaceId, paneId)?.frameId, opened.frameId);
  core.addStroke(surface.surfaceId, paneId, {
    strokeId: "second" as never, tool: "mouse", points: [{ x: 3, y: 4, timestamp: 120 }],
  });
  await source.resumePending();
  assert.equal(directCommits, 0, "stale recovery must not close reentered strokes");
  assert.equal(core.annotationPublisher!.openFrameFor(surface.surfaceId, paneId)?.frameId, opened.frameId);
  await source.setAnnotating(surface.surfaceId, paneId, false);
  const commits = core.annotationPublisher!.snapshot().surfaces[surface.surfaceId]!.fifo
    .map((entry) => JSON.parse(entry.canonical))
    .filter((record) => record.kind === "frame_commit");
  assert.equal(directCommits, 1);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].frameId, opened.frameId);
  assert.deepEqual(commits[0].payload.frame.strokes.map((stroke: { strokeId: string }) => stroke.strokeId),
    ["first", "second"]);
  source.stop();
});

test("gated source flush precedes a self-contained at-open frame commit", async () => {
  const core = new SurfaceCore({ annotationClientId: clientId });
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  core.admitSurfaceToLockless(surface.surfaceId);
  const paneId = core.activePaneIds(surface.surfaceId)[0]!;
  assert.ok(paneId > 0);
  core.locklessContentPush(surface.surfaceId, {
    content: { markdown: "annotation fixture" }, contentId: "content-one",
    contentType: "markdown", friendlyChatName: "Fixture", paneId,
  }, "Fixture");
  let durable = core.getPersistentState();
  let notified = 0;
  const source = new AnnotationSourceCoordinator(core, async () => {
    durable = core.getPersistentState();
  }, () => { notified += 1; }, (error) => { throw error; });
  await source.setAnnotating(surface.surfaceId, paneId, true);
  const open = core.annotationPublisher!.openFrame(surface.surfaceId, paneId, {
    contentId: "content-one", contextKey: "content-one", image: png,
    openedAt: 100, scrollOffset: { x: 4, y: 5 }, viewport,
  });
  core.addStroke(surface.surfaceId, paneId, {
    strokeId: "stroke-one" as never, tool: "mouse",
    points: [{ x: 6, y: 7, timestamp: 110 }, { x: 2, y: 3, timestamp: 120 }],
  });
  assert.equal(core.annotationPublisher!.pendingSurfaceIds().length, 0);
  await source.flushPending(surface.surfaceId, paneId);
  assert.equal(notified, 1);
  const afterFlush = core.annotationPublisher!.snapshot().surfaces[surface.surfaceId]!;
  assert.ok(afterFlush.fifo[0], JSON.stringify(afterFlush));
  const live = JSON.parse(afterFlush.fifo[0]!.canonical);
  assert.equal(live.kind, "live_delta");
  assert.equal(live.frameId, open.frameId);
  assert.equal(live.payload.strokes[0].strokeId, "stroke-one");
  assert.equal(core.hasPendingDrawingFlush(surface.surfaceId, paneId), true,
    "registry delivery must preserve the direct client's dirty stroke state");
  core.addStroke(surface.surfaceId, paneId, {
    strokeId: "stroke-two" as never, tool: "mouse", points: [{ x: 8, y: 9, timestamp: 130 }],
  });
  await source.flushPending(surface.surfaceId, paneId);
  const secondLive = JSON.parse(core.annotationPublisher!.snapshot().surfaces[surface.surfaceId]!.fifo[1]!.canonical);
  assert.deepEqual(secondLive.payload.strokes.map((stroke: { strokeId: string }) => stroke.strokeId), ["stroke-two"]);
  const canceledDone = source.setAnnotating(surface.surfaceId, paneId, false);
  await source.setAnnotating(surface.surfaceId, paneId, true);
  await canceledDone;
  assert.equal(core.annotationPublisher!.snapshot().surfaces[surface.surfaceId]!.fifo.length, 2);
  await source.setAnnotating(surface.surfaceId, paneId, false);
  const fifo = core.annotationPublisher!.snapshot().surfaces[surface.surfaceId]!.fifo;
  assert.equal(fifo.length, 3);
  const commit = JSON.parse(fifo[2]!.canonical);
  assert.equal(commit.kind, "frame_commit");
  assert.equal(commit.frameId, open.frameId);
  assert.equal(commit.payload.frame.image, open.image);
  assert.deepEqual(commit.payload.frame.scrollOffset, { x: 4, y: 5 });
  assert.equal(commit.payload.frame.strokes[0].strokeId, "stroke-one");
  assert.equal(commit.payload.frame.strokes.length, 2);
  assert.equal(notified, 3);
  assert.equal(core.annotationPublisher!.openFrameFor(surface.surfaceId, paneId), null);
  const restarted = new SurfaceCore({ annotationClientId: clientId, persistentState: durable });
  assert.equal(restarted.annotationPublisher!.snapshot().surfaces[surface.surfaceId]!.fifo.length, 3);
  source.stop();
});

test("unavailable at-open image produces an ordered durable source gap", async () => {
  const core = new SurfaceCore({ annotationClientId: clientId });
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  core.admitSurfaceToLockless(surface.surfaceId);
  const paneId = core.activePaneIds(surface.surfaceId)[0]!;
  core.locklessContentPush(surface.surfaceId, {
    content: { markdown: "annotation fixture" }, contentId: "content-one",
    contentType: "markdown", friendlyChatName: "Fixture", paneId,
  }, "Fixture");
  let durable = core.getPersistentState();
  const source = new AnnotationSourceCoordinator(core, async () => {
    durable = core.getPersistentState();
  }, () => {}, (error) => { throw error; });
  await source.setAnnotating(surface.surfaceId, paneId, true);
  core.annotationPublisher!.openFrame(surface.surfaceId, paneId, {
    contentId: "content-one", contextKey: "content-one", image: "", failed: true,
    openedAt: 100, scrollOffset: { x: 0, y: 0 }, viewport,
  });
  core.addStroke(surface.surfaceId, paneId, {
    strokeId: "stroke-one" as never, tool: "mouse", points: [{ x: 1, y: 2, timestamp: 110 }],
  });
  await source.setAnnotating(surface.surfaceId, paneId, false);
  const restored = new SurfaceCore({ annotationClientId: clientId, persistentState: durable });
  const gap = restored.annotationPublisher!.head(surface.surfaceId)!;
  assert.equal(gap.kind, "gap");
  const record = JSON.parse(gap.canonical);
  assert.equal(record.lostFromSequence, "1");
  assert.equal(record.lostThroughSequence, "2");
  assert.equal(record.reason, "source_retention_overflow");
  source.stop();
});

test("Done recovery keeps one source frame across pre-direct and post-direct crashes", async () => {
  for (const crashAfterDirect of [false, true]) {
    const core = new SurfaceCore({ annotationClientId: clientId });
    const surface = core.ensurePrimarySurface("Surf Ace", viewport);
    core.admitSurfaceToLockless(surface.surfaceId);
    const paneId = core.activePaneIds(surface.surfaceId)[0]!;
    core.locklessContentPush(surface.surfaceId, {
      content: { markdown: "annotation fixture" }, contentId: "content-one",
      contentType: "markdown", friendlyChatName: "Fixture", paneId,
    }, "Fixture");
    let durable = core.getPersistentState();
    const persist = async () => { durable = core.getPersistentState(); };
    const source = new AnnotationSourceCoordinator(core, persist, () => {}, () => {},
      async () => {
        const frame = durable.annotationPublisher?.surfaces[surface.surfaceId]?.openFrames?.[String(paneId)];
        assert.equal(frame?.commitRequested, true, "Done intent must survive before direct completion");
        assert.equal(durable.annotationPublisher?.surfaces[surface.surfaceId]?.fifo.some(
          (entry) => JSON.parse(entry.canonical).kind === "frame_commit"), false);
        if (crashAfterDirect) {
          core.markDrawingFlushSent(surface.surfaceId, paneId);
          core.markAnnotationCommittedSent(surface.surfaceId, paneId);
          await persist();
        }
        throw new Error("injected process interruption");
      });
    await source.setAnnotating(surface.surfaceId, paneId, true);
    const opened = core.annotationPublisher!.openFrame(surface.surfaceId, paneId, {
      contentId: "content-one", contextKey: "content-one", image: png,
      openedAt: 100, scrollOffset: { x: 0, y: 0 }, viewport,
    });
    core.addStroke(surface.surfaceId, paneId, {
      strokeId: "stroke-one" as never, tool: "mouse",
      points: [{ x: 1, y: 2, timestamp: 110 }],
    });
    await assert.rejects(source.setAnnotating(surface.surfaceId, paneId, false),
      /injected process interruption/);
    source.stop();
    const restored = new SurfaceCore({ annotationClientId: clientId, persistentState: durable });
    restored.restorePersistedSurfaces("Surf Ace", viewport);
    let directCalls = 0;
    let recovered = restored.getPersistentState();
    const resumed = new AnnotationSourceCoordinator(restored, async () => {
      recovered = restored.getPersistentState();
    }, () => {}, (error) => { throw error; }, async () => {
      directCalls += 1;
      restored.markDrawingFlushSent(surface.surfaceId, paneId);
      restored.markAnnotationCommittedSent(surface.surfaceId, paneId);
      recovered = restored.getPersistentState();
      return true;
    });
    await resumed.resumePending();
    const entries = recovered.annotationPublisher!.surfaces[surface.surfaceId]!.fifo;
    assert.deepEqual(entries.map((entry) => JSON.parse(entry.canonical).kind),
      ["live_delta", "frame_commit"], JSON.stringify({ crashAfterDirect, directCalls,
        pending: restored.hasPendingAnnotationCommit(surface.surfaceId, paneId),
        frame: recovered.annotationPublisher!.surfaces[surface.surfaceId]!.openFrames?.[String(paneId)] }));
    assert.equal(JSON.parse(entries[1]!.canonical).frameId, opened.frameId);
    assert.equal(recovered.annotationPublisher!.surfaces[surface.surfaceId]!.openFrames?.[String(paneId)], undefined);
    assert.equal(directCalls, crashAfterDirect ? 0 : 1);
    resumed.stop();
  }
});

test("reentry after durable direct commit closes the old source frame before a new stroke", async () => {
  const core = new SurfaceCore({ annotationClientId: clientId });
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  core.admitSurfaceToLockless(surface.surfaceId);
  const paneId = core.activePaneIds(surface.surfaceId)[0]!;
  core.locklessContentPush(surface.surfaceId, {
    content: { markdown: "annotation fixture" }, contentId: "content-one",
    contentType: "markdown", friendlyChatName: "Fixture", paneId,
  }, "Fixture");
  let durable = core.getPersistentState();
  let interruptSourceCommit = true;
  const persist = async () => {
    const candidate = core.getPersistentState();
    if (interruptSourceCommit && candidate.annotationPublisher?.surfaces[surface.surfaceId]?.fifo.some(
      (entry) => JSON.parse(entry.canonical).kind === "frame_commit")) {
      interruptSourceCommit = false;
      throw new Error("injected source commit write failure");
    }
    durable = candidate;
  };
  const source = new AnnotationSourceCoordinator(core, persist, () => {}, () => {}, async () => {
    core.markDrawingFlushSent(surface.surfaceId, paneId);
    core.markAnnotationCommittedSent(surface.surfaceId, paneId);
    await persist();
    return true;
  });
  await source.setAnnotating(surface.surfaceId, paneId, true);
  const old = core.annotationPublisher!.openFrame(surface.surfaceId, paneId, {
    contentId: "content-one", contextKey: "content-one", image: png,
    openedAt: 100, scrollOffset: { x: 0, y: 0 }, viewport,
  });
  core.addStroke(surface.surfaceId, paneId, {
    strokeId: "stroke-one" as never, tool: "mouse",
    points: [{ x: 1, y: 2, timestamp: 110 }],
  });
  await assert.rejects(source.setAnnotating(surface.surfaceId, paneId, false),
    /injected source commit write failure/);
  assert.equal(durable.annotationPublisher?.surfaces[surface.surfaceId]?.openFrames?.[String(paneId)]
    ?.directCommitDelivered, true);
  await source.setAnnotating(surface.surfaceId, paneId, true);
  const next = core.annotationPublisher!.openFrame(surface.surfaceId, paneId, {
    contentId: "content-one", contextKey: "content-one", image: png,
    openedAt: 200, scrollOffset: { x: 0, y: 0 }, viewport,
  });
  assert.notEqual(next.frameId, old.frameId);
  const commits = durable.annotationPublisher!.surfaces[surface.surfaceId]!.fifo
    .map((entry) => JSON.parse(entry.canonical)).filter((record) => record.kind === "frame_commit");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].frameId, old.frameId);
  assert.deepEqual(commits[0].payload.frame.strokes.map((stroke: { strokeId: string }) => stroke.strokeId),
    ["stroke-one"]);
  source.stop();
});

test("the lockless direct frame persists before the registry source frame commit", async () => {
  const core = new SurfaceCore({ annotationClientId: clientId });
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  core.admitSurfaceToLockless(surface.surfaceId);
  const paneId = core.activePaneIds(surface.surfaceId)[0]!;
  core.locklessContentPush(surface.surfaceId, {
    content: { markdown: "annotation fixture" }, contentId: "content-one",
    contentType: "markdown", friendlyChatName: "Fixture", paneId,
  }, "Fixture");
  const writes: ReturnType<SurfaceCore["getPersistentState"]>[] = [];
  const persist = async () => { writes.push(core.getPersistentState()); };
  const server = new SurfaceWsServer({
    bindAddress: "127.0.0.1", capturePaneImage: async () => png,
    compositorSocketPath: null, core, endpointName: "Surf Ace", hostName: "localhost",
    persistLocklessState: persist, port: 0, viewport: () => viewport,
  });
  server.setAnnotationCompletionManaged((surfaceId, id) =>
    core.annotationPublisher?.openFrameFor(surfaceId, id) != null);
  const source = new AnnotationSourceCoordinator(core, persist, () => {}, (error) => { throw error; },
    (surfaceId, id) => server.completeDirectAnnotation(surfaceId, id));
  await source.setAnnotating(surface.surfaceId, paneId, true);
  core.annotationPublisher!.openFrame(surface.surfaceId, paneId, {
    contentId: "content-one", contextKey: "content-one", image: png,
    openedAt: 100, scrollOffset: { x: 0, y: 0 }, viewport,
  });
  core.addStroke(surface.surfaceId, paneId, {
    strokeId: "stroke-one" as never, tool: "mouse",
    points: [{ x: 1, y: 2, timestamp: 110 }],
  });
  await source.setAnnotating(surface.surfaceId, paneId, false);
  const firstSourceCommit = writes.findIndex((state) =>
    Object.values(state.annotationPublisher?.surfaces ?? {}).some((partition) =>
      partition.fifo.some((entry) => JSON.parse(entry.canonical).kind === "frame_commit")));
  assert.ok(firstSourceCommit > 0);
  assert.equal(writes[firstSourceCommit - 1]!.surfaces?.find((item) => item.surfaceId === surface.surfaceId)
    ?.panes?.find((item) => item.paneId === paneId)?.pendingAnnotationCommit, false);
  assert.equal(core.hasPendingAnnotationCommit(surface.surfaceId, paneId), false);
  source.stop();
});

test("restart after the Done intent but before final flush resumes the same frame", async () => {
  const core = new SurfaceCore({ annotationClientId: clientId });
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  core.admitSurfaceToLockless(surface.surfaceId);
  const paneId = core.activePaneIds(surface.surfaceId)[0]!;
  core.locklessContentPush(surface.surfaceId, {
    content: { markdown: "annotation fixture" }, contentId: "content-one",
    contentType: "markdown", friendlyChatName: "Fixture", paneId,
  }, "Fixture");
  let durable = core.getPersistentState();
  let interruptFlush = true;
  const source = new AnnotationSourceCoordinator(core, async () => {
    const candidate = core.getPersistentState();
    if (interruptFlush && candidate.annotationPublisher?.surfaces[surface.surfaceId]?.fifo.some(
      (entry) => JSON.parse(entry.canonical).kind === "live_delta")) {
      interruptFlush = false;
      throw new Error("injected final flush write failure");
    }
    durable = candidate;
  }, () => {}, () => {}, async () => {
    throw new Error("direct completion must wait for the durable final flush");
  });
  await source.setAnnotating(surface.surfaceId, paneId, true);
  const opened = core.annotationPublisher!.openFrame(surface.surfaceId, paneId, {
    contentId: "content-one", contextKey: "content-one", image: png,
    openedAt: 100, scrollOffset: { x: 0, y: 0 }, viewport,
  });
  core.addStroke(surface.surfaceId, paneId, {
    strokeId: "stroke-one" as never, tool: "mouse",
    points: [{ x: 1, y: 2, timestamp: 110 }],
  });
  await assert.rejects(source.setAnnotating(surface.surfaceId, paneId, false),
    /injected final flush write failure/);
  source.stop();
  assert.equal(durable.annotationPublisher?.surfaces[surface.surfaceId]?.openFrames?.[String(paneId)]
    ?.commitRequested, true);
  const restored = new SurfaceCore({ annotationClientId: clientId, persistentState: durable });
  restored.restorePersistedSurfaces("Surf Ace", viewport);
  const resumed = new AnnotationSourceCoordinator(restored, async () => {
    durable = restored.getPersistentState();
  }, () => {}, (error) => { throw error; }, async () => {
    restored.markDrawingFlushSent(surface.surfaceId, paneId);
    restored.markAnnotationCommittedSent(surface.surfaceId, paneId);
    durable = restored.getPersistentState();
    return true;
  });
  await resumed.resumePending();
  const entries = durable.annotationPublisher!.surfaces[surface.surfaceId]!.fifo
    .map((entry) => JSON.parse(entry.canonical));
  assert.deepEqual(entries.map((entry) => entry.kind), ["live_delta", "frame_commit"]);
  assert.equal(entries[1]!.frameId, opened.frameId);
  resumed.stop();
});
