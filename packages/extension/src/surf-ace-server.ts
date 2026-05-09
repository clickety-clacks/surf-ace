import WebSocket, { type RawData } from "ws";
import type { Event, Request, Response } from "../../protocol/src/index.js";
import { validateEnvelopeType } from "../../protocol/src/validate.js";

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (response: Response) => void;
  timeout: NodeJS.Timeout;
};

export class SurfAceWireClient {
  private readonly url: string;
  private readonly onClose?: (code: number, reason: string) => void;
  private readonly onEvent?: (event: Event) => void;
  private readonly onRequest?: (request: Request) => Promise<Response> | Response;

  private closePromise: Promise<void> | null = null;
  private closeResolver: (() => void) | null = null;
  private pending = new Map<string, PendingRequest>();
  private ws: WebSocket | null = null;

  constructor(
    url: string,
    options?: {
      onClose?: (code: number, reason: string) => void;
      onEvent?: (event: Event) => void;
      onRequest?: (request: Request) => Promise<Response> | Response;
    },
  ) {
    this.url = url;
    this.onClose = options?.onClose;
    this.onEvent = options?.onEvent;
    this.onRequest = options?.onRequest;
  }

  async connect(timeoutMs: number): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const ws = new WebSocket(this.url, { handshakeTimeout: timeoutMs });
    this.ws = ws;
    this.closePromise = new Promise<void>((resolve) => {
      this.closeResolver = resolve;
    });

    ws.once("close", (code, reason) => {
      const text = reason.toString();
      this.rejectPending(new Error(`Surf Ace socket closed (${text || code})`));
      this.onClose?.(code, text);
      this.closeResolver?.();
      this.closeResolver = null;
      if (this.ws === ws) {
        this.ws = null;
      }
    });

    ws.on("message", (data) => {
      this.handleMessage(data);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to ${this.url}`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        ws.off("open", handleOpen);
        ws.off("error", handleError);
      };

      const handleOpen = () => {
        cleanup();
        resolve();
      };

      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };

      ws.once("open", handleOpen);
      ws.once("error", handleError);
    });

    ws.on("error", (error) => {
      console.warn(
        `[surf-ace:wire] WebSocket error after connect: ${String(error)}`,
      );
      // The 'close' event will follow; the onClose handler deals with
      // reconnection.  We only need to prevent the unhandled-error crash.
    });
  }

  async request(request: Request, timeoutMs: number): Promise<Response> {
    const ws = this.ensureOpenSocket();
    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      const finishReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.pending.delete(request.id);
        clearTimeout(timeout);
        reject(error);
      };
      const finishResolve = (response: Response) => {
        if (settled) {
          return;
        }
        settled = true;
        this.pending.delete(request.id);
        clearTimeout(timeout);
        resolve(response);
      };
      const timeout = setTimeout(() => {
        finishReject(new Error(`Timed out waiting for ${request.op} response`));
      }, timeoutMs);

      this.pending.set(request.id, {
        reject: finishReject,
        resolve: finishResolve,
        timeout,
      });

      try {
        ws.send(JSON.stringify(request));
      } catch (error) {
        finishReject(asError(error));
      }
    });
  }

  async close(code = 1000, reason = "provider_shutdown"): Promise<void> {
    const ws = this.ws;
    if (!ws) {
      return;
    }
    ws.close(code, reason);
    await this.waitForClose();
  }

  async waitForClose(): Promise<void> {
    await (this.closePromise ?? Promise.resolve());
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private ensureOpenSocket(): WebSocket {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Surf Ace socket is not open");
    }
    return this.ws;
  }

  private handleMessage(data: RawData): void {
    let parsed: Event | Request | Response;
    try {
      parsed = JSON.parse(toText(data)) as Event | Request | Response;
    } catch (error) {
      console.warn(
        `[surf-ace:wire] failed to parse incoming message: ${String(error)}`,
      );
      return;
    }

    if (parsed.type === "event") {
      try {
        this.onEvent?.(parsed);
      } catch (error) {
        console.warn(
          `[surf-ace:wire] unhandled error in onEvent callback (op=${parsed.op}): ${String(error)}`,
        );
      }
      return;
    }

    if (parsed.type === "request") {
      if (parsed.op === "target.register") {
        const validation = validateEnvelopeType("target.register", parsed);
        const reason = validation.ok
          ? "surface-side target.register is not supported by this product surface"
          : validation.reason;
        const ws = this.ws;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(targetRegisterRejected(parsed, reason)));
        }
        return;
      }
      void Promise.resolve()
        .then(async () => await this.onRequest?.(parsed))
        .then((response) => {
          if (!response) {
            return;
          }
          const ws = this.ws;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
          }
        })
        .catch((error) => {
          console.warn(
            `[surf-ace:wire] unhandled error in onRequest callback (op=${parsed.op}): ${String(error)}`,
          );
        });
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }

    this.pending.delete(parsed.id);
    clearTimeout(pending.timeout);
    pending.resolve(parsed);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function targetRegisterRejected(message: Request, reason: string): Response {
  const rawMessage = message as Record<string, unknown>;
  const payload = typeof rawMessage.payload === "object" && rawMessage.payload !== null
    ? rawMessage.payload as Record<string, unknown>
    : {};
  return {
    id: typeof message.id === "string" && message.id.length > 0 ? message.id : "target_register_invalid",
    ok: true,
    op: "target.register.rejected",
    payload: {
      errorCode: "registration_failed",
      idempotencyKey: typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : "unknown",
      message: `invalid target.register request: ${reason}`,
      status: "rejected",
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
  } as Response;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  if (data instanceof Buffer) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}
