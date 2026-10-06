import { createHash } from "node:crypto";

import { AnnotationFlushGate, type AnnotationFlushReason } from "./annotation-flush-gate.js";
import type { SurfaceCore } from "./surface-core.js";

/** Couples the direct drawing mutation to a separately durable registry source. */
export class AnnotationSourceCoordinator {
  private readonly gate: AnnotationFlushGate;
  private readonly doneEpoch = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly core: SurfaceCore,
    private readonly persist: () => Promise<void>,
    private readonly notify: () => void,
    onError: (error: unknown) => void,
  ) {
    this.gate = new AnnotationFlushGate((surfaceId, paneId, reason) =>
      this.flush(surfaceId, paneId, reason), onError);
    this.unsubscribe = core.subscribe((event) => {
      if (event.type === "drawing-dirty") this.gate.strokeEnded(event.surfaceId, event.paneId);
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
      this.core.setAnnotating(surfaceId, paneId, true);
      return;
    }
    await this.gate.flushPending(surfaceId, paneId);
    // A restored dirty pane has no in-memory timer, but still needs its final flush.
    if (this.core.hasPendingDrawingFlush(surfaceId, paneId)) {
      await this.flush(surfaceId, paneId, "idle_window");
    }
    if (this.doneEpoch.get(key) !== epoch) return;
    let appended = false;
    await this.core.transactionAsync(async () => {
      this.core.setAnnotating(surfaceId, paneId, false);
      const outbox = this.core.annotationPublisher;
      if (this.core.hasPendingAnnotationCommit(surfaceId, paneId) && outbox) {
        const frame = outbox.openFrameFor(surfaceId, paneId);
        const pane = this.core.getRendererWindowState(surfaceId).panes.find((item) => item.paneId === paneId);
        const contentType = pane?.content.contentType === "browser_url" ? "html" : pane?.content.contentType;
        if (!frame || frame.failed || !contentType || frame.contentId !== pane?.content.contentId) {
          outbox.lose(surfaceId, "annotation_frame_commit_unavailable");
        } else {
          outbox.append(surfaceId, {
            paneId, frameId: frame.frameId, kind: "frame_commit", contentId: frame.contentId,
            revision: pane!.content.revision, contentType, viewport: frame.viewport,
            sourceTimestamp: new Date().toISOString(),
            payload: { frame, imageSha256: createHash("sha256").update(Buffer.from(frame.image, "base64")).digest("hex") },
          });
        }
        appended = true;
      }
      outbox?.closeFrame(surfaceId, paneId);
      await this.persist();
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
      const payload = this.core.buildDrawingFlush(surfaceId, paneId,
        { idleWindowMs: 8_000, maxIntervalMs: 30_000 }, reason);
      if (!payload) return;
      const outbox = this.core.annotationPublisher!;
      const pane = this.core.getRendererWindowState(surfaceId).panes.find((item) => item.paneId === paneId);
      const frame = outbox.openFrameFor(surfaceId, paneId);
      const contentType = pane?.content.contentType === "browser_url" ? "html" : pane?.content.contentType;
      if (!frame || frame.failed || frame.contentId !== payload.contentId || !contentType) {
        outbox.lose(surfaceId, "annotation_at_open_frame_unavailable");
      } else {
        outbox.append(surfaceId, {
          paneId, frameId: frame.frameId, kind: "live_delta", contentId: payload.contentId,
          revision: payload.revision, contentType, viewport: this.core.captureSnapshot(surfaceId, paneId).viewport,
          sourceTimestamp: new Date().toISOString(), payload,
        });
      }
      this.core.markDrawingFlushSent(surfaceId, paneId);
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
