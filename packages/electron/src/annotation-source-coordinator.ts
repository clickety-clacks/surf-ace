import { createHash } from "node:crypto";

import { AnnotationFlushGate, type AnnotationFlushReason } from "./annotation-flush-gate.js";
import type { SurfaceCore } from "./surface-core.js";

/** Couples the direct drawing mutation to a separately durable registry source. */
export class AnnotationSourceCoordinator {
  private readonly gate: AnnotationFlushGate;
  private readonly doneEpoch = new Map<string, number>();
  private readonly completing = new Map<string, Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly core: SurfaceCore,
    private readonly persist: () => Promise<void>,
    private readonly notify: () => void,
    onError: (error: unknown) => void,
    private readonly completeDirect: (surfaceId: string, paneId: number) => Promise<boolean> = async (surfaceId, paneId) => {
      if (!core.hasPendingAnnotationCommit(surfaceId, paneId)) return false;
      core.markAnnotationCommittedSent(surfaceId, paneId);
      await persist();
      return true;
    },
  ) {
    this.gate = new AnnotationFlushGate((surfaceId, paneId, reason) =>
      this.flush(surfaceId, paneId, reason), onError);
    this.unsubscribe = core.subscribe((event) => {
      if (event.type === "drawing-dirty") this.gate.strokeEnded(event.surfaceId, event.paneId);
      if (event.type === "annotation-committed") {
        void this.finishRequestedFrame(event.surfaceId, event.paneId).catch(onError);
      }
    });
    for (const surface of core.listSurfaces()) {
      for (const paneId of core.activePaneIds(surface.surfaceId)) {
        if (core.hasPendingDrawingFlush(surface.surfaceId, paneId)) {
          this.gate.strokeEnded(surface.surfaceId, paneId);
        }
      }
    }
  }

  async setAnnotating(surfaceId: string, paneId: number, enabled: boolean): Promise<void> {
    const key = JSON.stringify([surfaceId, paneId]);
    const epoch = (this.doneEpoch.get(key) ?? 0) + 1;
    this.doneEpoch.set(key, epoch);
    if (enabled) {
      await this.core.transactionAsync(async () => {
        this.core.setAnnotating(surfaceId, paneId, true);
        this.core.annotationPublisher?.requestFrameCommit(surfaceId, paneId, false);
        await this.persist();
      });
      return;
    }
    await this.core.transactionAsync(async () => {
      this.core.setAnnotating(surfaceId, paneId, false);
      if (this.core.hasPendingAnnotationCommit(surfaceId, paneId)) {
        this.core.annotationPublisher?.requestFrameCommit(surfaceId, paneId, true);
      }
      await this.persist();
    });
    if (this.doneEpoch.get(key) === epoch) await this.finishRequestedFrame(surfaceId, paneId);
  }

  async resumePending(): Promise<void> {
    for (const surface of this.core.listSurfaces()) {
      for (const paneId of this.core.activePaneIds(surface.surfaceId)) {
        if (this.core.hasPendingAnnotationCommit(surface.surfaceId, paneId) ||
            this.core.annotationPublisher?.openFrameFor(surface.surfaceId, paneId)?.commitRequested) {
          await this.finishRequestedFrame(surface.surfaceId, paneId);
        }
      }
    }
  }

  async finishRequestedFrame(surfaceId: string, paneId: number): Promise<void> {
    const key = JSON.stringify([surfaceId, paneId]);
    const pending = this.completing.get(key);
    if (pending) return await pending;
    const work = this.finishRequestedFrameExclusive(surfaceId, paneId);
    this.completing.set(key, work);
    try { await work; }
    finally { if (this.completing.get(key) === work) this.completing.delete(key); }
  }

  private async finishRequestedFrameExclusive(surfaceId: string, paneId: number): Promise<void> {
    const outbox = this.core.annotationPublisher;
    if (!outbox) return;
    const frame = outbox.openFrameFor(surfaceId, paneId);
    if (!frame?.commitRequested) return;
    const key = JSON.stringify([surfaceId, paneId]);
    const epoch = this.doneEpoch.get(key);
    if (!frame.directCommitDelivered && this.core.hasPendingAnnotationCommit(surfaceId, paneId)) {
      await this.gate.flushPending(surfaceId, paneId);
      if (this.core.hasPendingDrawingFlush(surfaceId, paneId)) {
        await this.flush(surfaceId, paneId, "idle_window");
      }
      if (this.doneEpoch.get(key) !== epoch || !outbox.openFrameFor(surfaceId, paneId)?.commitRequested) return;
      if (!await this.completeDirect(surfaceId, paneId)) return;
    }
    // A restart after the direct persistence boundary sees the pane's pending
    // bit cleared while the source frame still carries the requested intent.
    if (!this.core.hasPendingAnnotationCommit(surfaceId, paneId) &&
        !outbox.openFrameFor(surfaceId, paneId)?.directCommitDelivered) {
      await this.core.transactionAsync(async () => {
        outbox.markDirectCommitDelivered(surfaceId, paneId);
        await this.persist();
      });
    }
    let appended = false;
    await this.core.transactionAsync(async () => {
      const current = outbox.openFrameFor(surfaceId, paneId);
      if (!current?.commitRequested || !current.directCommitDelivered) return;
      const pane = this.core.getRendererWindowState(surfaceId).panes.find((item) => item.paneId === paneId);
      const contentType = pane?.content.contentType === "browser_url" ? "html" : pane?.content.contentType;
      if (current.failed || !contentType || current.contentId !== pane?.content.contentId) {
        outbox.lose(surfaceId, "annotation_frame_commit_unavailable");
      } else {
        const closedFrame = {
          frameId: current.frameId, contextKey: current.contextKey, contentId: current.contentId,
          ...(current.url === undefined ? {} : { url: current.url }),
          scrollOffset: current.scrollOffset, viewport: current.viewport,
          openedAt: current.openedAt, updatedAt: current.updatedAt,
          image: current.image, strokes: current.strokes,
        };
        outbox.append(surfaceId, {
          paneId, frameId: current.frameId, kind: "frame_commit", contentId: current.contentId,
          revision: pane!.content.revision, contentType, viewport: current.viewport,
          sourceTimestamp: new Date().toISOString(),
          payload: { frame: closedFrame,
            imageSha256: createHash("sha256").update(Buffer.from(current.image, "base64")).digest("hex") },
        });
      }
      outbox.closeFrame(surfaceId, paneId);
      await this.persist();
      appended = true;
    });
    if (appended) this.notify();
  }

  async flushPending(surfaceId: string, paneId: number): Promise<void> {
    await this.gate.flushPending(surfaceId, paneId);
  }

  private async flush(surfaceId: string, paneId: number, reason: AnnotationFlushReason): Promise<void> {
    if (!this.core.annotationPublisher) return;
    let appended = false;
    await this.core.transactionAsync(async () => {
      const outbox = this.core.annotationPublisher!;
      const payload = this.core.buildDrawingFlush(surfaceId, paneId,
        { idleWindowMs: 8_000, maxIntervalMs: 30_000 }, reason);
      const pane = this.core.getRendererWindowState(surfaceId).panes.find((item) => item.paneId === paneId);
      let frame = outbox.openFrameFor(surfaceId, paneId);
      if (!frame && payload) {
        // A failed at-open capture still needs a stable loss position across retries.
        outbox.openFrame(surfaceId, paneId, {
          contextKey: payload.contentId, contentId: payload.contentId, image: "", failed: true,
          openedAt: payload.firstStrokeAt, scrollOffset: this.core.captureSnapshot(surfaceId, paneId).viewport.scrollOffset,
          viewport: this.core.viewport(surfaceId),
        });
        for (const stroke of payload.strokes) outbox.recordStroke(surfaceId, paneId, stroke);
        frame = outbox.openFrameFor(surfaceId, paneId);
      }
      if (!frame) return;
      const pending = (frame.sourceStrokeCount ?? frame.strokes.length) - (frame.publishedStrokeCount ?? 0);
      if (pending <= 0) return;
      const contentType = pane?.content.contentType === "browser_url" ? "html" : pane?.content.contentType;
      if (!payload || frame.failed || frame.contentId !== payload.contentId || !contentType) {
        outbox.lose(surfaceId, "annotation_at_open_frame_unavailable");
      } else {
        const ids = new Set(frame.strokes.slice(frame.publishedStrokeCount ?? 0).map((stroke) => stroke.strokeId));
        const strokes = payload.strokes.filter((stroke) => ids.has(stroke.strokeId));
        if (strokes.length !== pending) {
          outbox.lose(surfaceId, "annotation_source_strokes_unavailable");
        } else {
          const firstStrokeAt = strokes[0]!.points[0]!.timestamp;
          const lastStroke = strokes[strokes.length - 1]!;
          const lastStrokeAt = lastStroke.points[lastStroke.points.length - 1]!.timestamp;
          outbox.append(surfaceId, {
            paneId, frameId: frame.frameId, kind: "live_delta", contentId: payload.contentId,
            revision: payload.revision, contentType, viewport: this.core.captureSnapshot(surfaceId, paneId).viewport,
            sourceTimestamp: new Date().toISOString(), payload: { ...payload, strokes,
              firstStrokeAt, lastStrokeAt, strokeCount: strokes.length,
              pointsCount: strokes.reduce((count, stroke) => count + stroke.points.length, 0) },
          });
        }
      }
      outbox.markFramePublished(surfaceId, paneId);
      await this.persist();
      appended = true;
    });
    if (appended) this.notify();
  }

  stop(): void {
    this.unsubscribe();
    this.gate.stop();
  }
}
