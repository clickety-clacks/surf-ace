import { parseAnnotationCursor, type AnnotationCursor } from "@surf-ace/protocol";
import { PublicControllerWireClient, type ControllerWireEnvelope } from "../../controller/src/wire.js";
import type { SurfaceCore } from "./surface-core.js";

export type AnnotationPublisherWire = Pick<PublicControllerWireClient,
  "connect" | "request" | "onClose" | "close" | "abort">;

/** A single foreground publisher connection to the configured registry. */
export class AnnotationRegistryPublisher {
  private readonly wire: AnnotationPublisherWire;
  private running = false;
  private wanted = false;
  private stopped = false;
  private helloDone = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> = Promise.resolve();

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
      if (!this.stopped && this.core.annotationPublisher!.pendingSurfaceIds().length > 0) this.retry();
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
    if (this.stopped || this.retryTimer || this.core.annotationPublisher!.pendingSurfaceIds().length === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.notify();
    }, 2_000);
  }

  private async ensureHello(): Promise<void> {
    if (this.helloDone) return;
    await this.wire.connect();
    const response = await this.wire.request("annotation.hello", { protocolVersion: 1, role: "publisher" });
    if (!response.ok) throw new Error(`annotation_hello_failed:${response.error?.code ?? "unknown"}`);
    this.helloDone = true;
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      this.wanted = false;
      const surfaceId = this.core.annotationPublisher!.pendingSurfaceIds()[0];
      if (!surfaceId) return;
      await this.ensureHello();
      const outbox = this.core.annotationPublisher!;
      const entry = outbox.needsSeal(surfaceId)
        ? await this.core.transactionAsync(async () => {
            const sealed = outbox.head(surfaceId);
            await this.persist();
            return sealed;
          })
        : outbox.head(surfaceId);
      if (!entry) continue;
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
        throw new Error(`annotation_ingest_failed:${response.error?.code ?? "unknown"}`);
      }
      const cursor = this.acceptedCursor(response);
      await this.core.transactionAsync(async () => {
        outbox.accepted(surfaceId, entry, cursor);
        await this.persist();
      });
    }
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
