import { parseAnnotationCursor, type AnnotationCursor } from "@surf-ace/protocol";
import { PublicControllerWireClient, type ControllerWireEnvelope } from "../../controller/src/wire.js";
import type { SurfaceCore } from "./surface-core.js";
import type { AnnotationDeliveryReceipt } from "./annotation-publisher-outbox.js";

export type AnnotationDeliveryStatus = { phase: "waiting" | "sending" | "sent" | "rejected"; error?: boolean };

export type AnnotationPublisherWire = Pick<PublicControllerWireClient,
  "connect" | "request" | "onClose" | "close" | "abort">;

class AnnotationPublisherRefusal extends Error {
  constructor(readonly code: string) { super(`annotation registry refused ${code}`); }
}

/** A single foreground publisher connection to the configured registry. */
export class AnnotationRegistryPublisher {
  private readonly wire: AnnotationPublisherWire;
  private running = false;
  private wanted = false;
  private stopped = false;
  private helloDone = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> = Promise.resolve();
  private lastSurfaceId: string | null = null;
  private savedReceipts: Record<string, AnnotationDeliveryReceipt[]>;
  private savedPendingFrames: ReturnType<NonNullable<SurfaceCore["annotationPublisher"]>["pendingDeliveryFramesSnapshot"]>;
  private sending: { surfaceId: string; sourceEventId: string } | null = null;
  private readonly deliveryErrors = new Set<string>();

  constructor(
    address: string,
    private readonly core: SurfaceCore,
    private readonly persist: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
    wireFactory: (url: string) => AnnotationPublisherWire = (url) => new PublicControllerWireClient(url),
    private readonly onStatus: () => void = () => {},
  ) {
    const url = new URL(address);
    if (!(["ws:", "wss:"].includes(url.protocol)) || !core.annotationPublisher) {
      throw new TypeError("annotation publisher requires a configured registry and durable outbox");
    }
    this.wire = wireFactory(url.toString());
    this.savedReceipts = core.annotationPublisher.deliveryReceiptsSnapshot();
    this.savedPendingFrames = core.annotationPublisher.pendingDeliveryFramesSnapshot();
    for (const surfaceId of core.annotationPublisher.unhealthySurfaceIds()) this.deliveryErrors.add(surfaceId);
    this.wire.onClose(() => {
      this.helloDone = false;
      if (!this.stopped && this.core.annotationPublisher!.publishableSurfaceIds().length > 0) this.retry();
    });
  }

  start(): void { this.notify(); }
  sourceSaved(): void { this.publishStatus(true); this.notify(); }
  localSaved(): void { this.publishStatus(true); }

  deliveryStatus(surfaceId: string, paneId: number, paneLineageId: string, contentId: string,
    revision: number, frameId?: string): AnnotationDeliveryStatus | null {
    const receipt = this.savedReceipts[surfaceId]?.find((r) => r.paneId === paneId &&
      r.paneLineageId === paneLineageId && r.contentId === contentId && r.revision === revision &&
      (frameId === undefined || r.frameId === frameId));
    if (!receipt) {
      const pending = this.savedPendingFrames[surfaceId]?.some((f) => f.commitRequested &&
        f.paneId === paneId && f.paneLineageId === paneLineageId && f.contentId === contentId &&
        f.contentRevision === revision && (frameId === undefined || f.frameId === frameId));
      return pending ? { phase: "waiting", ...(this.deliveryErrors.has(surfaceId) ? { error: true } : {}) } : null;
    }
    if (receipt.phase === "rejected") return { phase: "rejected" };
    if (receipt.phase === "sent" && receipt.kind === "frame_commit") return { phase: "sent" };
    const sending = this.sending?.surfaceId === surfaceId && this.sending.sourceEventId === receipt.sourceEventId;
    return { phase: sending ? "sending" : "waiting", ...(this.deliveryErrors.has(surfaceId) ? { error: true } : {}) };
  }

  private publishStatus(refreshSaved = false): void {
    if (refreshSaved) {
      this.savedReceipts = this.core.annotationPublisher!.deliveryReceiptsSnapshot();
      this.savedPendingFrames = this.core.annotationPublisher!.pendingDeliveryFramesSnapshot();
    }
    try { this.onStatus(); } catch { /* UI observers cannot change source delivery. */ }
  }

  /** Called only after a source record has been durably appended. */
  notify(): void {
    if (this.stopped) return;
    this.wanted = true;
    if (this.running) return;
    this.running = true;
    this.active = this.drain().catch((error) => {
      if (this.sending || this.lastSurfaceId) this.deliveryErrors.add(this.sending?.surfaceId ?? this.lastSurfaceId!);
      this.sending = null;
      this.publishStatus();
      this.onError(error);
      this.retry();
    }).finally(() => {
      this.running = false;
      if (this.wanted && !this.stopped && !this.retryTimer) this.notify();
    });
  }

  private retry(): void {
    if (this.stopped || this.retryTimer || this.core.annotationPublisher!.publishableSurfaceIds().length === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.notify();
    }, 2_000);
  }

  private async ensureHello(): Promise<void> {
    if (this.helloDone) return;
    await this.wire.connect();
    const response = await this.wire.request("annotation.hello", { protocolVersion: 1, role: "publisher" });
    if (!response.ok) throw new AnnotationPublisherRefusal(response.error?.code ?? "annotation_protocol_invalid");
    this.helloDone = true;
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      this.wanted = false;
      const candidates = this.core.annotationPublisher!.publishableSurfaceIds().sort();
      const surfaceId = candidates.find((id) => this.lastSurfaceId === null || id > this.lastSurfaceId!) ?? candidates[0];
      if (!surfaceId) return;
      this.lastSurfaceId = surfaceId;
      try { await this.ensureHello(); }
      catch (error) {
        if (error instanceof AnnotationPublisherRefusal && error.code !== "writer_fence_unavailable") {
          await this.markUnhealthy(surfaceId, error.code);
          continue;
        }
        throw error;
      }
      const outbox = this.core.annotationPublisher!;
      const entry = outbox.needsSeal(surfaceId)
        ? await this.core.transactionAsync(async () => {
            const sealed = outbox.head(surfaceId);
            await this.persist();
            return sealed;
          })
        : outbox.head(surfaceId);
      if (!entry) continue;
      // A source mutation can have joined an outstanding core transaction while
      // its own disk write is queued. Persist the selected canonical head before
      // the first send, even when an earlier acceptance just persisted.
      await this.persist();
      const durableHead = outbox.head(surfaceId);
      if (!durableHead || durableHead.canonical !== entry.canonical) continue;
      const op = entry.kind === "gap" ? "annotation.source_gap" : "annotation.ingest";
      this.sending = { surfaceId, sourceEventId: entry.sourceEventId };
      this.deliveryErrors.delete(surfaceId);
      this.publishStatus(true); // selected head has just been persisted
      const response = await this.wire.request(op, { record: JSON.parse(entry.canonical) });
      this.sending = null;
      if (!response.ok) {
        if (entry.kind === "payload" &&
            (response.error?.code === "annotation_record_too_large" ||
             response.error?.code === "annotation_context_image_invalid")) {
          await this.core.transactionAsync(async () => {
            outbox.rejectHead(surfaceId, response.error!.code as
              "annotation_record_too_large" | "annotation_context_image_invalid");
            await this.persist();
            this.publishStatus(true);
          });
          continue;
        }
        if (entry.kind === "gap" || (response.error?.code !== "annotation_ingest_capacity" &&
            response.error?.code !== "writer_fence_unavailable")) {
          await this.markUnhealthy(surfaceId, response.error?.code ?? "annotation_protocol_invalid");
          continue;
        }
        throw new Error(`annotation_ingest_failed:${response.error?.code ?? "unknown"}`);
      }
      let cursor: AnnotationCursor;
      try { cursor = this.acceptedCursor(response); }
      catch {
        await this.markUnhealthy(surfaceId, "annotation_ingest_invalid_response");
        continue;
      }
      await this.core.transactionAsync(async () => {
        outbox.accepted(surfaceId, entry, cursor);
        await this.persist();
        // A server response alone is insufficient for a restored Sent label.
        this.publishStatus(true);
      });
    }
  }

  private async markUnhealthy(surfaceId: string, code: string): Promise<void> {
    await this.core.transactionAsync(async () => {
      this.core.annotationPublisher!.markUnhealthy(surfaceId, code);
      await this.persist();
      this.deliveryErrors.add(surfaceId);
      this.publishStatus(true);
    });
    this.onError(new AnnotationPublisherRefusal(code));
  }

  private acceptedCursor(response: ControllerWireEnvelope): AnnotationCursor {
    const payload = response.payload as { serverCursor?: unknown; duplicate?: unknown; committedAt?: unknown } | null;
    if (!payload || typeof payload.duplicate !== "boolean" || typeof payload.committedAt !== "string") {
      throw new Error("annotation_ingest_invalid_response");
    }
    return parseAnnotationCursor(payload.serverCursor);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.wire.abort();
    await this.active.catch(() => undefined);
    await this.wire.close();
  }
}
