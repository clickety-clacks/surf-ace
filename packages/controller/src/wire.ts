import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket, { type RawData } from "ws";

import { reconnectDelayMs, REGISTRY_FRAME_TIMEOUT_MS, WEBSOCKET_CONNECT_TIMEOUT_MS } from "@surf-ace/protocol";

export type ControllerWireEnvelope = {
  error?: {
    code?: string;
    details?: unknown;
    message?: string;
    retryable?: boolean;
  };
  id?: string;
  ok?: boolean;
  op: string;
  payload?: unknown;
  sentAt?: number;
  type: "event" | "request" | "response";
  v?: number;
};

export type AllocatorSurfaceIdentity = {
  authorityId: string;
  expectedAllocatorId: string;
  fleetId: string;
  ownerAnchorId: string;
  surfaceId: string;
};

export type AllocatorWindowLabel = {
  allocatorId: string;
  authorityId: string;
  committed: true;
  fleetId: string;
  ordinal: number;
  ownerAnchorId: string;
  stateVersion: number;
  surfaceId: string;
  windowLabel: string;
};

export type RegistryIdentity = {
  allocatorId: string;
  fleetId: string;
};

export function parseRegistryIdentity(payload: unknown): RegistryIdentity {
  const identity = (payload as { registryIdentity?: RegistryIdentity } | null)?.registryIdentity;
  if (!identity ||
      typeof identity.allocatorId !== "string" ||
      !/^alloc_[A-Za-z0-9._:-]{3,64}$/.test(identity.allocatorId) ||
      typeof identity.fleetId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(identity.fleetId)) {
    throw new Error("registry_identity_missing_or_invalid");
  }
  return { allocatorId: identity.allocatorId, fleetId: identity.fleetId };
}

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (response: ControllerWireEnvelope) => void;
  timeout?: NodeJS.Timeout;
};

export class PublicControllerWireClient {
  private readonly closeListeners = new Set<() => void>();
  private readonly eventListeners =
    new Set<(event: ControllerWireEnvelope) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private socket: WebSocket | null = null;

  private opening: Promise<void> | null = null;
  private readonly registry: boolean;
  private readonly requestTimeoutMs: number;
  private readonly retryStoreFailures: boolean;
  private readonly onRetry?: (error: NonNullable<ControllerWireEnvelope["error"]>) => void;

  constructor(
    readonly url: string,
    options: number | {
      registry: true;
      onRetry?: (error: NonNullable<ControllerWireEnvelope["error"]>) => void;
      retryStoreFailures?: boolean;
    } = 10_000,
  ) {
    this.registry = typeof options !== "number";
    this.retryStoreFailures = typeof options !== "number" && options.retryStoreFailures !== false;
    this.requestTimeoutMs = typeof options === "number" ? options : 10_000;
    if (typeof options !== "number") this.onRetry = options.onRetry;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return await this.opening;
    if (this.socket) throw new Error("controller_wire_closing");

    const socket = new WebSocket(this.url, { handshakeTimeout: WEBSOCKET_CONNECT_TIMEOUT_MS });
    this.socket = socket;
    let frameDeadline: NodeJS.Timeout | undefined;
    const receivedFrame = () => {
      if (!this.registry) return;
      clearTimeout(frameDeadline);
      frameDeadline = setTimeout(() => socket.terminate(), REGISTRY_FRAME_TIMEOUT_MS);
    };
    socket.on("message", (data) => {
      receivedFrame();
      if (this.socket === socket) this.handleMessage(data);
    });
    socket.on("ping", receivedFrame);
    socket.on("pong", receivedFrame);
    this.opening = new Promise<void>((resolve, reject) => {
      socket.on("error", reject);
      socket.once("open", () => {
        receivedFrame();
        resolve();
      });
      socket.once("close", () => {
        clearTimeout(frameDeadline);
        reject(new Error("controller_wire_closed"));
        if (this.socket !== socket) return;
        this.socket = null;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("controller_wire_closed"));
        }
        this.pending.clear();
        for (const listener of this.closeListeners) listener();
      });
    });
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  // Identity comes from the caller's existing authority. This connection never
  // mints an identity or a label; reconnect confirms the prior committed label.
  async connectAllocatorSurface(
    identity: AllocatorSurfaceIdentity,
    previous?: Pick<AllocatorWindowLabel, "committed" | "ordinal" | "windowLabel">,
  ): Promise<AllocatorWindowLabel> {
    await this.connect();
    const { surfaceId, ...owner } = identity;
    const binding = await this.request("authority.bind", {
      ...owner,
      protocolVersion: 1,
    });
    if (binding.ok !== true) {
      throw new Error(`allocator_request_rejected:authority.bind:${binding.error?.code}`);
    }
    const op = previous ? "label.reconfirm" : "label.claim";
    const response = await this.request(op, {
      ...owner,
      protocolVersion: 1,
      surfaceId,
      ...(previous ? {
        expectedAssignment: {
          committed: previous.committed,
          ordinal: previous.ordinal,
          windowLabel: previous.windowLabel,
        },
      } : {}),
    });
    if (response.ok !== true) {
      throw new Error(`allocator_request_rejected:${op}:${response.error?.code}`);
    }
    const assignment = response.payload as AllocatorWindowLabel | undefined;
    if (
      !assignment || assignment.committed !== true ||
      assignment.allocatorId !== identity.expectedAllocatorId ||
      assignment.fleetId !== identity.fleetId ||
      assignment.authorityId !== identity.authorityId ||
      assignment.ownerAnchorId !== identity.ownerAnchorId ||
      assignment.surfaceId !== surfaceId
    ) {
      throw new Error("allocator_assignment_identity_mismatch");
    }
    return assignment;
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async readRegistryIdentity(): Promise<RegistryIdentity> {
    await this.connect();
    const response = await this.request("fleet.topology");
    if (response.type !== "response" || response.v !== 1 || response.op !== "fleet.topology") {
      throw new Error("registry_identity_response_mismatch");
    }
    if (response.ok !== true) {
      throw new Error(`registry_identity_unavailable:${response.error?.code ?? "unknown"}`);
    }
    return parseRegistryIdentity(response.payload);
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
    if (!this.retryStoreFailures) return await this.sendRequest(op, payload, id);
    const socket = this.socket;
    const retry = new AbortController();
    const unlisten = this.onClose(() => retry.abort(new Error("controller_wire_closed")));
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (socket !== this.socket) throw new Error("controller_wire_closed");
        const response = await this.sendRequest(op, payload, id);
        if (response.ok !== false || !response.error?.retryable ||
            response.op !== op || response.v !== 1) return response;
        this.onRetry?.(response.error);
        try {
          await delay(reconnectDelayMs(attempt), undefined, { signal: retry.signal });
        } catch (error) {
          throw retry.signal.aborted ? retry.signal.reason : error;
        }
      }
    } finally {
      unlisten();
    }
  }

  private async sendRequest(op: string, payload: unknown, id: string): Promise<ControllerWireEnvelope> {
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
      if (this.pending.has(id)) {
        reject(new Error("controller_wire_request_already_pending"));
        return;
      }
      const timeout = this.registry ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`controller_wire_timeout:${op}`));
      }, this.requestTimeoutMs);
      const pending = { reject, resolve, timeout };
      this.pending.set(id, pending);
      socket.send(JSON.stringify(envelope), (error) => {
        if (!error || this.pending.get(id) !== pending) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      if (this.registry || socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, "controller_shutdown");
    });
  }

  private handleMessage(data: RawData): void {
    let envelope: ControllerWireEnvelope;
    try {
      envelope = JSON.parse(data.toString()) as ControllerWireEnvelope;
    } catch {
      if (this.registry) this.abort();
      return;
    }
    if (!envelope || typeof envelope !== "object") {
      if (this.registry) this.abort();
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
