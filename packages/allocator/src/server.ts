import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

import WebSocket, { WebSocketServer, type RawData } from "ws";
import { parseAnnotationCursor } from "@surf-ace/protocol";

import { WindowLabelAuthority } from "./authority.js";
import { AnnotationJournal } from "./annotation-journal.js";
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
import { PostgresCustodyAdapter, type AdapterTestHooks, type AnnotationInfo, type PostgresCustodyConfig } from "./custody.js";
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
  nextPaneOrdinalFence: number;
  primaryHeadHash: string;
  primaryHeadSeq: number;
  serveStatus: string;
  registrationReady: boolean;
  stateVersion: number;
  uptimeMs: number;
  witnessHeadHash: string;
  witnessHeadSeq: number;
  witnessPhysicalSlot: string;
  witnessServerId: string;
};

type AnnotationLease = {
  consumerId: string;
  leaseId: string;
  socket: WebSocket | null;
  epoch: string;
  nextSequence: bigint;
  acknowledged: bigint;
  delivered: Array<{ sequence: bigint; bytes: number }>;
  gap: { gapId: string; throughCursor: { epoch: string; sequence: string } } | null;
  pumping: boolean;
  pumpRequested: boolean;
};

export class AllocatorServer {
  private readonly startedAt = Date.now();
  private readonly annotationRoles = new WeakMap<WebSocket, "publisher" | "consumer">();
  private readonly annotationLeases = new Map<string, AnnotationLease>();
  private readonly registeredClients = new Map<string, unknown>();
  private registrationTail: Promise<unknown> = Promise.resolve();

  private async registerClient(payload: unknown): Promise<unknown> {
    const value = payload as { clientId?: unknown; surfaces?: unknown };
    if (!value || typeof value.clientId !== "string" || !/^[a-f0-9]{64}$/.test(value.clientId) ||
        !Array.isArray(value.surfaces)) throw new Error("invalid_registration");
    const clientId = value.clientId;
    const surfaces = value.surfaces as Array<{ surfaceId: string; panes: Array<{ paneId: string; paneLabel: number; paneLineageId: string }> }>;
    const ids = new Set<string>();
    for (const surface of surfaces) {
      if (!surface || typeof surface.surfaceId !== "string" || !/^sf_[A-Za-z0-9._:-]{3,64}$/.test(surface.surfaceId) ||
          ids.has(surface.surfaceId) || !Array.isArray(surface.panes)) throw new Error("invalid_surface");
      ids.add(surface.surfaceId);
      const paneIds = new Set<string>();
      for (const pane of surface.panes) {
        if (!pane || typeof pane.paneId !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(pane.paneId) ||
            typeof pane.paneLineageId !== "string" || !/^pl_[A-Za-z0-9._:-]{3,128}$/.test(pane.paneLineageId) ||
            paneIds.has(pane.paneId)) throw new Error("invalid_pane");
        paneIds.add(pane.paneId);
      }
    }
    const state = await this.custody.readAcceptedState();
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const identity = {
      authorityId: "auth_" + hash(state.allocatorId),
      ownerAnchorId: "owner_" + hash(state.fleetId),
      fleetId: state.fleetId,
      expectedAllocatorId: state.allocatorId,
      protocolVersion: 1 as const,
    };
    await this.authority.bind(identity);
    const registered = [];
    for (const surface of surfaces) {
      const assignment = await this.authority.claim({
        ...identity, surfaceId: "sf_" + hash(JSON.stringify([clientId, surface.surfaceId])),
      });
      const panes = [];
      for (const pane of surface.panes) {
        const paneLabel = await this.custody.claimPane(clientId, surface.surfaceId, pane.paneId, pane.paneLineageId);
        panes.push({ paneId: pane.paneId, paneLineageId: pane.paneLineageId,
          paneLabel, paneAddress: assignment.windowLabel + paneLabel });
      }
      registered.push({
        surfaceId: surface.surfaceId,
        windowLabel: assignment.windowLabel,
        panes,
      });
    }
    const result = { clientId, surfaces: registered };
    this.registeredClients.set(clientId, result);
    return result;
  }

  private async claimPane(payload: unknown): Promise<{ paneLabel: number }> {
    const value = payload as { clientId?: unknown; surfaceId?: unknown; paneId?: unknown; paneLineageId?: unknown };
    if (!value || typeof value.clientId !== "string" || !/^[a-f0-9]{64}$/.test(value.clientId) ||
        typeof value.surfaceId !== "string" || !/^sf_[A-Za-z0-9._:-]{3,64}$/.test(value.surfaceId) ||
        typeof value.paneId !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(value.paneId) ||
        typeof value.paneLineageId !== "string" || !/^pl_[A-Za-z0-9._:-]{3,128}$/.test(value.paneLineageId)) {
      throw new Error("invalid_pane_claim");
    }
    const registered = this.registeredClients.get(value.clientId) as
      | { surfaces: Array<{ surfaceId: string }> } | undefined;
    if (!registered?.surfaces.some((surface) => surface.surfaceId === value.surfaceId)) {
      throw new Error("surface_not_registered");
    }
    return { paneLabel: await this.custody.claimPane(value.clientId, value.surfaceId, value.paneId, value.paneLineageId) };
  }

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
        // Annotation state must be verified and old leases fenced before the
        // listener can accept a hello. Older schemas remain direct-only.
        let annotationInstalled = true;
        try {
          await custody.annotationInfo();
        } catch (error) {
          if ((error as { code?: string }).code !== "42883") throw error;
          annotationInstalled = false;
        }
        if (annotationInstalled) await custody.verifyAnnotationStartup();
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
      nextPaneOrdinalFence: state.nextPaneOrdinalFence,
      primaryHeadHash: state.headHash,
      primaryHeadSeq: state.headSeq,
      serveStatus: this.authority.serveStatus !== "serving"
        ? this.authority.serveStatus
        : this.custody.registrationReady ? "serving" : "writer-unvalidated",
      registrationReady: this.custody.registrationReady && this.authority.serveStatus === "serving",
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
    await this.registrationTail;
    try {
      await this.custody.release();
    } finally {
      this.hostLock.release();
    }
  }

  private accept(socket: WebSocket): void {
    const replay = new Map<string, { fingerprint: string; response: string }>();
    let annotationTail: Promise<unknown> = Promise.resolve();
    socket.on("message", (data) => {
      // Annotation role and append order are connection state; process their
      // messages serially so hello cannot race an immediately following ingest.
      if (toText(data).includes('"annotation.')) {
        annotationTail = annotationTail.then(() => this.handle(socket, data, replay));
        void annotationTail.catch(() => socket.close(1011, "annotation_handler_failed"));
      } else {
        void this.handle(socket, data, replay);
      }
    });
    socket.on("close", () => {
      for (const lease of this.annotationLeases.values()) {
        if (lease.socket !== socket) continue;
        lease.socket = null;
        void this.custody.disconnectAnnotationConsumer(lease.consumerId, lease.leaseId)
          .catch(() => undefined);
      }
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
    const registration = raw as { v?: unknown; type?: unknown; id?: unknown; op?: unknown; payload?: unknown };
    if (typeof registration?.op === "string" && registration.op.startsWith("annotation.")) {
      await this.handleAnnotation(socket, registration);
      return;
    }
    if (registration && (registration.op === "client.register" || registration.op === "pane.claim" || registration.op === "fleet.topology")) {
      const run = this.registrationTail.then(async () => {
        if (registration.v !== 1 || registration.type !== "request" || typeof registration.id !== "string" || !registration.id) {
          socket.close(1008, "invalid_envelope");
          return;
        }
        try {
          if (registration.op !== "fleet.topology"
              && (!this.custody.registrationReady || this.authority.serveStatus !== "serving")) {
            // The registration queue serializes recovery with claims, independent of discovery probes.
            await this.authority.refreshReadiness();
          }
          const payload = registration.op === "client.register"
            ? await this.registerClient(registration.payload)
            : registration.op === "pane.claim"
              ? await this.claimPane(registration.payload)
              : {
                clients: [...this.registeredClients.values()],
                registrationReady: await this.authority.refreshReadiness(),
              };
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
            v: 1, type: "response", id: registration.id, op: registration.op, ok: true, payload, sentAt: Date.now(),
          }));
        } catch (error) {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
            v: 1, type: "response", id: registration.id, op: registration.op, ok: false,
            error: { code: "registration_failed", message: error instanceof Error ? error.message : "registration_failed" },
            sentAt: Date.now(),
          }));
        }
      });
      this.registrationTail = run.catch(() => undefined);
      await run;
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

  private async handleAnnotation(socket: WebSocket, request: {
    v?: unknown; type?: unknown; id?: unknown; op?: unknown; payload?: unknown;
  }): Promise<void> {
    const op = String(request.op);
    if (request.v !== 1 || request.type !== "request" || typeof request.id !== "string" ||
        request.id.length === 0 || !Number.isSafeInteger((request as { sentAt?: unknown }).sentAt) ||
        Number((request as { sentAt?: unknown }).sentAt) < 0) {
      socket.close(1008, "invalid_envelope");
      return;
    }
    const reply = (ok: boolean, value: unknown): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ v: 1, type: "response", op, id: request.id,
        ok, sentAt: Date.now(), [ok ? "payload" : "error"]: value }));
    };
    try {
      if (op === "annotation.hello") {
        if (this.annotationRoles.has(socket)) throw new AllocatorError("annotation_invalid_request", "hello already completed");
        const payload = request.payload as Record<string, unknown>;
        if (!payload || Object.keys(payload).sort().join(",") !== "protocolVersion,role" ||
            payload.protocolVersion !== 1 || (payload.role !== "publisher" && payload.role !== "consumer")) {
          throw new AllocatorError("annotation_invalid_request", "invalid annotation hello");
        }
        let info;
        try { info = await this.custody.annotationInfo(); }
        catch (error) {
          if ((error as { code?: string }).code === "42883") {
            throw new AllocatorError("annotation_protocol_unsupported", "annotation migration is not installed");
          }
          throw error;
        }
        const state = await this.custody.readAcceptedState();
        this.annotationRoles.set(socket, payload.role);
        reply(true, {
          registryId: state.allocatorId,
          journalEpoch: info.epoch,
          availableFromCursor: info.firstRetainedSequence === null ? null : { epoch: info.epoch, sequence: info.firstRetainedSequence },
          headCursor: info.headSequence === "0" ? null : { epoch: info.epoch, sequence: info.headSequence },
          limits: annotationLimits(info),
          usage: { journalRecords: info.journalRecords, journalCanonicalBytes: info.journalCanonicalBytes,
            sourceMetadataRows: info.sourceMetadataRows, sourceMetadataBytes: info.sourceMetadataBytes,
            consumerSlots: info.consumerSlots, activeStreams: info.activeStreams },
        });
      } else if (op === "annotation.ingest" || op === "annotation.source_gap") {
        if (this.annotationRoles.get(socket) !== "publisher") {
          throw new AllocatorError("annotation_role_operation_invalid", "publisher hello is required");
        }
        const payload = request.payload as Record<string, unknown>;
        if (!payload || Object.keys(payload).length !== 1 || !("record" in payload)) {
          throw new AllocatorError("annotation_invalid_request", "expected one record");
        }
        const isGap = typeof payload.record === "object" && payload.record !== null &&
          "reason" in payload.record;
        if (isGap !== (op === "annotation.source_gap")) {
          throw new AllocatorError("annotation_invalid_request", "record kind and operation differ");
        }
        reply(true, await new AnnotationJournal(this.custody).ingest(payload.record));
        for (const lease of this.annotationLeases.values()) void this.pumpAnnotation(lease);
      } else if (op === "annotation.watch" || op === "annotation.resume") {
        if (this.annotationRoles.get(socket) !== "consumer") {
          throw new AllocatorError("annotation_role_operation_invalid", "consumer hello is required");
        }
        const payload = request.payload as Record<string, unknown>;
        const keys = Object.keys(payload ?? {}).sort().join(",");
        if ((op === "annotation.watch" && keys !== "consumerId" && keys !== "consumerId,fromCursor") ||
            (op === "annotation.resume" && keys !== "consumerId") ||
            typeof payload.consumerId !== "string" || Buffer.byteLength(payload.consumerId, "utf8") < 1 ||
            Buffer.byteLength(payload.consumerId, "utf8") > 128) {
          throw new AllocatorError("annotation_invalid_request", "invalid consumer request");
        }
        let from;
        if (payload.fromCursor !== undefined) {
          try { from = parseAnnotationCursor(payload.fromCursor); }
          catch { throw new AllocatorError("annotation_cursor_invalid", "invalid requested cursor"); }
        }
        const prior = this.annotationLeases.get(payload.consumerId);
        if (op === "annotation.resume" && prior?.socket?.readyState === WebSocket.OPEN) {
          this.emitAnnotation(prior.socket, "annotation.lease_replaced", { consumerId: payload.consumerId, leaseId: prior.leaseId });
          await new Promise<void>((resolve) => {
            prior.socket!.once("close", resolve);
            prior.socket!.close(1000, "lease_replaced");
            setTimeout(resolve, 1000);
          });
        }
        const opened = await this.custody.openAnnotationConsumer(payload.consumerId,
          op === "annotation.watch" ? "watch" : "resume", from);
        const next = opened.ackCursor
          ? BigInt(opened.ackCursor.sequence) + 1n
          : BigInt(opened.initialFromCursor.sequence);
        const lease: AnnotationLease = { consumerId: payload.consumerId, leaseId: opened.leaseId,
          socket, epoch: opened.ackCursor?.epoch ?? opened.initialFromCursor.epoch, nextSequence: next,
          acknowledged: opened.ackCursor ? BigInt(opened.ackCursor.sequence) : next - 1n,
          delivered: [], gap: null, pumping: false, pumpRequested: false };
        this.annotationLeases.set(payload.consumerId, lease);
        reply(true, { ...opened, limits: annotationLimits(await this.custody.annotationInfo()) });
        void this.pumpAnnotation(lease);
      } else if (op === "annotation.ack") {
        if (this.annotationRoles.get(socket) !== "consumer") {
          throw new AllocatorError("annotation_role_operation_invalid", "consumer hello is required");
        }
        const payload = request.payload as Record<string, unknown>;
        if (!payload || Object.keys(payload).sort().join(",") !== "consumerId,leaseId,throughCursor" ||
            typeof payload.consumerId !== "string" || typeof payload.leaseId !== "string") {
          throw new AllocatorError("annotation_invalid_request", "invalid acknowledgement");
        }
        let cursor;
        try { cursor = parseAnnotationCursor(payload.throughCursor); }
        catch { throw new AllocatorError("annotation_cursor_invalid", "invalid acknowledgement cursor"); }
        const lease = this.annotationLeases.get(payload.consumerId);
        if (!lease || lease.leaseId !== payload.leaseId) {
          throw new AllocatorError("annotation_consumer_lease_stale", "lease has been replaced");
        }
        if (lease.gap) throw new AllocatorError("annotation_gap_ack_required", "history gap requires explicit acknowledgement");
        const sequence = BigInt(cursor.sequence);
        if (cursor.epoch !== lease.epoch || sequence > lease.acknowledged &&
            !lease.delivered.some((item) => item.sequence === sequence)) {
          throw new AllocatorError("annotation_ack_not_delivered", "cursor was not delivered under this lease");
        }
        const acknowledged = await this.custody.ackAnnotationConsumer(payload.consumerId, payload.leaseId, cursor);
        lease.acknowledged = sequence;
        lease.delivered = lease.delivered.filter((item) => item.sequence > sequence);
        reply(true, { ackCursor: acknowledged });
        void this.pumpAnnotation(lease);
      } else if (op === "annotation.gap.ack") {
        if (this.annotationRoles.get(socket) !== "consumer") {
          throw new AllocatorError("annotation_role_operation_invalid", "consumer hello is required");
        }
        const payload = request.payload as Record<string, unknown>;
        if (!payload || Object.keys(payload).sort().join(",") !== "consumerId,gapId,leaseId" ||
            typeof payload.consumerId !== "string" || typeof payload.leaseId !== "string" ||
            typeof payload.gapId !== "string") {
          throw new AllocatorError("annotation_invalid_request", "invalid gap acknowledgement");
        }
        const lease = this.annotationLeases.get(payload.consumerId);
        if (!lease || lease.leaseId !== payload.leaseId) {
          throw new AllocatorError("annotation_consumer_lease_stale", "lease has been replaced");
        }
        if (!lease.gap || lease.gap.gapId !== payload.gapId) {
          throw new AllocatorError("annotation_gap_id_mismatch", "gap ID does not match current gap");
        }
        const through = lease.gap.throughCursor;
        const position = await this.custody.ackAnnotationGap(payload.consumerId, payload.leaseId, through);
        lease.epoch = through.epoch;
        lease.acknowledged = BigInt(through.sequence);
        lease.nextSequence = lease.acknowledged + 1n;
        lease.delivered = [];
        lease.gap = null;
        reply(true, { ackCursor: position, gapId: payload.gapId });
        void this.pumpAnnotation(lease);
      } else if (op === "annotation.consumer.retire") {
        if (this.annotationRoles.get(socket) !== "consumer") {
          throw new AllocatorError("annotation_role_operation_invalid", "consumer hello is required");
        }
        const payload = request.payload as Record<string, unknown>;
        if (!payload || Object.keys(payload).sort().join(",") !==
            "consumerId,discardUnacknowledged,expectedAckCursor" ||
            typeof payload.consumerId !== "string") {
          throw new AllocatorError("annotation_invalid_request", "invalid retirement request");
        }
        let expected = null;
        if (payload.expectedAckCursor !== null) {
          try { expected = parseAnnotationCursor(payload.expectedAckCursor, true); }
          catch { throw new AllocatorError("annotation_cursor_invalid", "invalid expected cursor"); }
        }
        const retired = await this.custody.retireAnnotationConsumer(
          payload.consumerId, expected, payload.discardUnacknowledged === true);
        reply(true, retired);
        const lease = this.annotationLeases.get(payload.consumerId);
        if (lease) {
          this.annotationLeases.delete(payload.consumerId);
          if (lease.socket?.readyState === WebSocket.OPEN) {
            this.emitAnnotation(lease.socket, "annotation.consumer_retired", retired);
            lease.socket.close(1000, "consumer_retired");
          }
        }
      } else {
        throw new AllocatorError("annotation_protocol_unsupported", "annotation operation is not implemented");
      }
    } catch (error) {
      const failure = error instanceof AllocatorError ? error : asAllocatorError(error);
      reply(false, { code: failure.code, message: failure.message,
        ...(failure.details ? { details: failure.details } : {}) });
    }
  }

  private emitAnnotation(socket: WebSocket, op: string, payload: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ v: 1, type: "event", op,
      eventId: randomBytes(16).toString("hex"), sentAt: Date.now(), payload }));
  }

  private async pumpAnnotation(lease: AnnotationLease): Promise<void> {
    lease.pumpRequested = true;
    if (lease.pumping) return;
    lease.pumping = true;
    try {
      while (lease.pumpRequested && lease.socket?.readyState === WebSocket.OPEN &&
             this.annotationLeases.get(lease.consumerId) === lease) {
        lease.pumpRequested = false;
        if (lease.gap) break;
        const info = await this.custody.annotationInfo();
        const floor = info.firstRetainedSequence === null ? BigInt(info.headSequence) + 1n
          : BigInt(info.firstRetainedSequence);
        if (lease.epoch !== info.epoch || lease.nextSequence < floor) {
          const gapId = randomBytes(16).toString("hex");
          const throughCursor = { epoch: info.epoch, sequence: (floor - 1n).toString() };
          lease.gap = { gapId, throughCursor };
          this.emitAnnotation(lease.socket, "annotation.history_gap", {
            gapId, requestedCursor: { epoch: lease.epoch, sequence: lease.nextSequence.toString() },
            availableFromCursor: info.firstRetainedSequence === null ? null :
              { epoch: info.epoch, sequence: info.firstRetainedSequence },
            throughCursor,
            headCursor: info.headSequence === "0" ? null : { epoch: info.epoch, sequence: info.headSequence },
            reason: lease.epoch === info.epoch ? "cursor_expired" : "epoch_changed",
          });
          break;
        }
        while (lease.delivered.length < 32 && lease.socket?.readyState === WebSocket.OPEN) {
          const bytesInFlight = lease.delivered.reduce((sum, item) => sum + item.bytes, 0);
          const records = await this.custody.readAnnotationRecords(lease.nextSequence.toString(), 1);
          const record = records[0];
          if (!record || record.epoch !== lease.epoch ||
              bytesInFlight + record.bytes > 67_108_864) break;
          this.emitAnnotation(lease.socket, "annotation.record", {
            serverCursor: { epoch: record.epoch, sequence: record.sequence },
            record: record.record, committedAt: record.committedAt,
          });
          const sequence = BigInt(record.sequence);
          lease.delivered.push({ sequence, bytes: record.bytes });
          lease.nextSequence = sequence + 1n;
        }
      }
    } catch {
      lease.socket?.close(1011, "annotation_delivery_failed");
    } finally {
      lease.pumping = false;
    }
  }
}

function annotationLimits(info: AnnotationInfo) {
  return {
  journalRecords: info.maxJournalRecords, journalAndSourceMetadataBytes: info.maxJournalAndMetadataBytes,
  sourceMetadataRows: info.maxSourceMetadataRows, consumerIds: 64, activeStreams: 32,
  inFlightRecordsPerConsumer: 32, inFlightCanonicalBytesPerConsumer: 67_108_864,
  maxRecordBytes: 16_777_216,
  replayPolicy: { targetAcknowledgedHistoryDays: 30, pressureCompaction: true,
    requireActualConsumerAcknowledgement: true },
  };
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
