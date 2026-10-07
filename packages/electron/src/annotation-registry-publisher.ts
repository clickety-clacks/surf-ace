import { parseAnnotationCursor, type AnnotationCursor } from "@surf-ace/protocol";
import { PublicControllerWireClient, type ControllerWireEnvelope } from "../../controller/src/wire.js";
import type { SurfaceCore } from "./surface-core.js";

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

  constructor(
    address: string,
    private readonly core: SurfaceCore,
    private readonly persist: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
    wireFactory: (url: string) => AnnotationPublisherWire = (url) => new PublicControllerWireClient(url),
  ) {
    const url = new URL(address);
    if (!(["ws:", "wss:"].includes(url.protocol)) || !core.annotationPublisher) {
      throw new TypeError("annotation publisher requires a configured registry and durable outbox");
    }
    this.wire = wireFactory(url.toString());
    this.wire.onClose(() => {
      this.helloDone = false;
      if (!this.stopped && this.core.annotationPublisher!.publishableSurfaceIds().length > 0) this.retry();
    });
  }

  start(): void { this.notify(); }

  /** Called only after a source record has been durably appended. */
  notify(): void {
    if (this.stopped) return;
    this.wanted = true;
    if (this.running) return;
    this.running = true;
    this.active = this.drain().catch((error) => {
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
      const response = await this.wire.request(op, { record: JSON.parse(entry.canonical) });
      if (!response.ok) {
        if (entry.kind === "payload" &&
            (response.error?.code === "annotation_record_too_large" ||
             response.error?.code === "annotation_context_image_invalid")) {
          await this.core.transactionAsync(async () => {
            outbox.rejectHead(surfaceId, response.error!.code as
              "annotation_record_too_large" | "annotation_context_image_invalid");
            await this.persist();
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
      });
    }
  }

  private async markUnhealthy(surfaceId: string, code: string): Promise<void> {
    await this.core.transactionAsync(async () => {
      this.core.annotationPublisher!.markUnhealthy(surfaceId, code);
      await this.persist();
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
