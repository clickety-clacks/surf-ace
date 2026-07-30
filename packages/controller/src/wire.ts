import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";

export type ControllerWireEnvelope = {
  error?: {
    code?: string;
    details?: unknown;
    message?: string;
  };
  id?: string;
  ok?: boolean;
  op: string;
  payload?: unknown;
  sentAt?: number;
  type: "event" | "request" | "response";
  v?: number;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (response: ControllerWireEnvelope) => void;
  timeout: NodeJS.Timeout;
};

export class PublicControllerWireClient {
  private readonly closeListeners = new Set<() => void>();
  private readonly eventListeners =
    new Set<(event: ControllerWireEnvelope) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private socket: WebSocket | null = null;

  constructor(
    readonly url: string,
    private readonly requestTimeoutMs = 10_000,
  ) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(data));
    socket.on("close", () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("controller_wire_closed"));
        this.pending.delete(id);
      }
      if (this.socket === socket) {
        this.socket = null;
      }
      for (const listener of this.closeListeners) {
        listener();
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  onEvent(listener: (event: ControllerWireEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  abort(): void {
    this.socket?.terminate();
  }

  async request(
    op: string,
    payload: unknown = {},
    id = `rq_${randomUUID().replaceAll("-", "")}`,
  ): Promise<ControllerWireEnvelope> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("controller_wire_not_connected");
    }
    const envelope: ControllerWireEnvelope = {
      id,
      op,
      payload,
      sentAt: Date.now(),
      type: "request",
      v: 1,
    };
    return await new Promise<ControllerWireEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`controller_wire_timeout:${op}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { reject, resolve, timeout });
      socket.send(JSON.stringify(envelope));
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close(1000, "controller_shutdown");
    });
  }

  private handleMessage(data: RawData): void {
    let envelope: ControllerWireEnvelope;
    try {
      envelope = JSON.parse(data.toString()) as ControllerWireEnvelope;
    } catch {
      return;
    }
    if (envelope.type === "event") {
      for (const listener of this.eventListeners) {
        listener(envelope);
      }
      return;
    }
    if (envelope.type !== "response" || !envelope.id) {
      return;
    }
    const pending = this.pending.get(envelope.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(envelope.id);
    pending.resolve(envelope);
  }
}
