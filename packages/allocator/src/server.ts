import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { WindowLabelAuthority } from "./authority.js";
import {
  AllocatorError,
  canonicalJson,
  type AllocatorErrorResponse,
  type AllocatorOperation,
  type AllocatorRequest,
  type AllocatorSuccessResponse,
  type AuthorityBindPayload,
  type LabelClaimPayload,
  type LabelReconfirmPayload,
} from "./domain.js";
import { PostgresCustodyAdapter, type AdapterTestHooks, type PostgresCustodyConfig } from "./custody.js";
import { parseAllocatorRequest } from "./validation.js";

export type AllocatorServerConfig = {
  custody: PostgresCustodyConfig;
  hostLockPath: string;
  listenHost: string;
  listenPort: number;
};

export type AllocatorDiagnostics = {
  allocatorId: string;
  assignmentCount: number;
  burnedOrdinalCount: number;
  custodyRevision: number;
  fleetId: string;
  lastSuccessfulCommitTime: string | null;
  leaseBackendPid: number;
  leaseGeneration: number;
  leaseId: string;
  leaseMode: "writer";
  lifecycle: "active" | "destroyed";
  nextOrdinalFence: number;
  primaryHeadHash: string;
  primaryHeadSeq: number;
  serveStatus: string;
  stateVersion: number;
  uptimeMs: number;
  witnessHeadHash: string;
  witnessHeadSeq: number;
  witnessPhysicalSlot: string;
  witnessServerId: string;
};

export class AllocatorServer {
  private readonly startedAt = Date.now();
  private constructor(
    private readonly config: AllocatorServerConfig,
    private readonly hostLock: HostLock,
    private readonly custody: PostgresCustodyAdapter<"writer">,
    private readonly authority: WindowLabelAuthority,
    private readonly webSocketServer: WebSocketServer,
  ) {}

  static async start(config: AllocatorServerConfig, testHooks: AdapterTestHooks = {}): Promise<AllocatorServer> {
    validateServerConfig(config);
    const hostLock = HostLock.acquire(config.hostLockPath);
    try {
      const custody = await PostgresCustodyAdapter.acquireWriter(config.custody, testHooks);
      try {
        const authority = new WindowLabelAuthority(custody);
        await authority.recoverPreparedTransactions();
        await custody.validateLease();
        const webSocketServer = new WebSocketServer({
          host: config.listenHost,
          port: config.listenPort,
        });
        await new Promise<void>((resolve, reject) => {
          webSocketServer.once("listening", resolve);
          webSocketServer.once("error", reject);
        });
        const server = new AllocatorServer(config, hostLock, custody, authority, webSocketServer);
        webSocketServer.on("connection", (socket) => server.accept(socket));
        return server;
      } catch (error) {
        await custody.terminate();
        throw error;
      }
    } catch (error) {
      hostLock.release();
      throw error;
    }
  }

  get address(): { host: string; port: number; url: string } {
    const address = this.webSocketServer.address();
    if (!address || typeof address === "string") {
      throw new Error("allocator listener has no TCP address");
    }
    return {
      host: this.config.listenHost,
      port: address.port,
      url: `ws://${this.config.listenHost}:${address.port}`,
    };
  }

  async diagnostics(): Promise<AllocatorDiagnostics> {
    const [state, witness] = await Promise.all([
      this.custody.readAcceptedState(),
      this.custody.readWitness(),
    ]);
    return {
      allocatorId: state.allocatorId,
      assignmentCount: state.mappings.length,
      burnedOrdinalCount: state.transactions.filter((entry) => entry.status === "burned").length,
      custodyRevision: state.custodyRevision,
      fleetId: state.fleetId,
      lastSuccessfulCommitTime: state.lastCommitAt,
      leaseBackendPid: state.leaseBackendPid ?? -1,
      leaseGeneration: this.custody.token.leaseGeneration,
      leaseId: this.custody.token.leaseId,
      leaseMode: "writer",
      lifecycle: state.lifecycle,
      nextOrdinalFence: state.nextOrdinalFence,
      primaryHeadHash: state.headHash,
      primaryHeadSeq: state.headSeq,
      serveStatus: this.authority.serveStatus,
      stateVersion: state.stateVersion,
      uptimeMs: Date.now() - this.startedAt,
      witnessHeadHash: witness.headHash,
      witnessHeadSeq: witness.headSeq,
      witnessPhysicalSlot: witness.receiverSlotName,
      witnessServerId: witness.witnessServerId,
    };
  }

  async close(): Promise<void> {
    for (const client of this.webSocketServer.clients) client.close(1001, "allocator_shutdown");
    await new Promise<void>((resolve, reject) => {
      this.webSocketServer.close((error) => error ? reject(error) : resolve());
    });
    try {
      await this.custody.release();
    } finally {
      this.hostLock.release();
    }
  }

  private accept(socket: WebSocket): void {
    const replay = new Map<string, { fingerprint: string; response: string }>();
    socket.on("message", (data) => {
      void this.handle(socket, data, replay);
    });
  }

  private async handle(
    socket: WebSocket,
    data: RawData,
    replay: Map<string, { fingerprint: string; response: string }>,
  ): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(toText(data));
    } catch {
      socket.close(1008, "invalid_json");
      return;
    }
    let request: AllocatorRequest;
    try {
      request = parseAllocatorRequest(raw);
    } catch (error) {
      const correlated = correlation(raw);
      if (!correlated) {
        socket.close(1008, "invalid_envelope");
        return;
      }
      socket.send(JSON.stringify(errorResponse(correlated.id, correlated.op, asAllocatorError(error))));
      return;
    }
    const fingerprint = canonicalJson({ op: request.op, payload: request.payload } as never);
    const cached = replay.get(request.id);
    if (cached) {
      if (cached.fingerprint === fingerprint) {
        socket.send(cached.response);
      } else {
        socket.send(JSON.stringify(errorResponse(
          request.id,
          request.op,
          new AllocatorError("invalid_request_id_reuse", "request id was reused with another payload"),
        )));
      }
      return;
    }

    let response: AllocatorSuccessResponse | AllocatorErrorResponse;
    try {
      const payload = request.op === "authority.bind"
        ? await this.authority.bind(request.payload as AuthorityBindPayload)
        : request.op === "label.claim"
          ? await this.authority.claim(request.payload as LabelClaimPayload)
          : await this.authority.reconfirm(request.payload as LabelReconfirmPayload);
      response = {
        id: request.id,
        ok: true,
        op: request.op,
        payload,
        sentAt: Date.now(),
        type: "response",
        v: 1,
      };
    } catch (error) {
      response = errorResponse(request.id, request.op, asAllocatorError(error));
    }
    const encoded = JSON.stringify(response);
    replay.set(request.id, { fingerprint, response: encoded });
    if (replay.size > 1024) replay.delete(replay.keys().next().value!);
    if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
  }
}

class HostLock {
  private released = false;
  private constructor(
    private readonly path: string,
    private readonly descriptor: number,
    private readonly nonce: string,
  ) {}

  static acquire(path: string): HostLock {
    const nonce = randomBytes(24).toString("base64url");
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      throw new AllocatorError("writer_fence_unavailable", `canonical host lock is unavailable: ${path}`, undefined, error);
    }
    try {
      writeSync(descriptor, `${process.pid}:${nonce}\n`);
      fsyncSync(descriptor);
      return new HostLock(path, descriptor, nonce);
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.descriptor);
    const contents = readFileSync(this.path, "utf8");
    if (contents === `${process.pid}:${this.nonce}\n`) unlinkSync(this.path);
  }
}

function errorResponse(id: string, op: AllocatorOperation, error: AllocatorError): AllocatorErrorResponse {
  return {
    error: {
      code: error.code,
      ...(error.allocatorId ? { details: { allocatorId: error.allocatorId } } : {}),
      message: error.message,
    },
    id,
    ok: false,
    op,
    sentAt: Date.now(),
    type: "response",
    v: 1,
  };
}

function correlation(value: unknown): { id: string; op: AllocatorOperation } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (record.op !== "authority.bind" && record.op !== "label.claim" && record.op !== "label.reconfirm") return null;
  return { id: record.id, op: record.op };
}

function asAllocatorError(error: unknown): AllocatorError {
  return error instanceof AllocatorError
    ? error
    : new AllocatorError("internal_error", "allocator request failed", undefined, error);
}

function toText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function validateServerConfig(config: AllocatorServerConfig): void {
  if (!config.listenHost || !Number.isInteger(config.listenPort) || config.listenPort < 0 || config.listenPort > 65535) {
    throw new TypeError("allocator listenHost and listenPort must be explicit and valid");
  }
  if (!config.hostLockPath) throw new TypeError("allocator hostLockPath is required");
}
