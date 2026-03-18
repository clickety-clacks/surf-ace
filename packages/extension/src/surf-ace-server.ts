import WebSocket, { type RawData } from "ws";
import type { Event, Request, Response } from "../../protocol/src/index.js";

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (response: Response) => void;
  timeout: NodeJS.Timeout;
};

export class SurfAceWireClient {
  private readonly url: string;
  private readonly onClose?: (code: number, reason: string) => void;
  private readonly onEvent?: (event: Event) => void;

  private closePromise: Promise<void> | null = null;
  private closeResolver: (() => void) | null = null;
  private pending = new Map<string, PendingRequest>();
  private ws: WebSocket | null = null;

  constructor(
    url: string,
    options?: {
      onClose?: (code: number, reason: string) => void;
      onEvent?: (event: Event) => void;
    },
  ) {
    this.url = url;
    this.onClose = options?.onClose;
    this.onEvent = options?.onEvent;
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

    ws.on("message", (data) => {
      this.handleMessage(data);
    });

    ws.once("close", (code, reason) => {
      const text = reason.toString();
      this.rejectPending(new Error(`Surf Ace socket closed (${text || code})`));
      this.onClose?.(code, text);
      this.closeResolver?.();
      this.closeResolver = null;
      this.ws = null;
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
    const parsed = JSON.parse(toText(data)) as Event | Response;
    if (parsed.type === "event") {
      this.onEvent?.(parsed);
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
