import { randomUUID } from "node:crypto";

import type {
  ConsumableGap,
  ConsumableRecord,
  ConsumableScopeSnapshot,
  ControllerInstanceId,
  LocklessConsumableAck,
  LocklessContentPush,
  LocklessPaneCloseIntent,
  LocklessPaneRestoreIntent,
  LocklessPaneSplitIntent,
  LocklessPairResult,
  LocklessScopeId,
  LocklessSurfaceCloseIntent,
  LocklessSurfaceOpenIntent,
  LocklessSurfaceRestoreIntent,
} from "@surf-ace/protocol";
import { SURF_ACE_LOCKLESS_V1_CAPABILITY } from "@surf-ace/protocol";

import { ControllerIdentity } from "./identity.js";
import {
  BoundedControllerProjection,
  type LocalConsumableRead,
} from "./projection.js";
import {
  type ControllerWireEnvelope,
} from "./wire.js";

export const LOCKLESS_WIRE_OPS = {
  acknowledge: "consumable.ack",
  closePane: "pane.close",
  closeSurface: "surface.window.close",
  contentPush: "content.set",
  consumableAvailable: "event.consumable_available",
  consumableDelta: "event.lockless_consumable_delta",
  consumableOverflow: "event.consumable_overflow",
  consumableSync: "consumable.sync",
  listSurfaces: "surfaces.list",
  pair: "pair.request",
  restorePane: "pane.restore",
  restoreSurface: "surface.window.restore",
  scopeSnapshot: "event.lockless_scope_snapshot",
  splitPane: "pane.split",
  openSurface: "surface.window.open",
} as const;

export interface ControllerWire {
  abort?(): void;
  close(): Promise<void>;
  connect(): Promise<void>;
  onEvent(listener: (event: ControllerWireEnvelope) => void): () => void;
  onClose?(listener: () => void): () => void;
  request(
    op: string,
    payload?: unknown,
    id?: string,
  ): Promise<ControllerWireEnvelope>;
}

export type LocklessControllerSessionOptions = {
  controllerProductName?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  identity: ControllerIdentity;
  projection: BoundedControllerProjection;
  protocolFeatures?: string[];
  reconnectInitialDelayMs?: number;
  onConsumableAvailable?: (scopeId: LocklessScopeId) => void;
  onConsumableAcknowledged?: (scopeId: LocklessScopeId) => void;
  preflightComplete?: boolean;
  surfaceId?: string;
  wire: ControllerWire;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_lockless_wire_payload");
  }
  return value as Record<string, unknown>;
}

function responsePayload(response: ControllerWireEnvelope): Record<string, unknown> {
  if (response.ok === false) {
    const payload = response.payload === undefined ? {} : record(response.payload);
    const code = response.error?.code ??
      (typeof payload.code === "string"
        ? payload.code
        : typeof payload.errorCode === "string"
          ? payload.errorCode
          : "unknown");
    throw new Error(`lockless_request_rejected:${response.op}:${code}`);
  }
  const payload = record(response.payload);
  const receipt =
    payload.receipt &&
      typeof payload.receipt === "object" &&
      !Array.isArray(payload.receipt)
      ? record(payload.receipt)
      : {};
  const clientResultIds = Object.fromEntries(
    Object.entries(payload).filter(([key, value]) =>
      (
        key.endsWith("Id") ||
        key.endsWith("Revision") ||
        key === "revision" ||
        key === "commitSequence"
      ) &&
      (typeof value === "string" || typeof value === "number")
    ),
  );
  if (
    typeof receipt.commitSequence === "string" ||
    typeof receipt.commitSequence === "number"
  ) {
    clientResultIds.commitSequence = receipt.commitSequence;
  }
  return {
    ...payload,
    operationReceipt: {
      clientResultIds,
      operation: response.op,
      requestId: response.id ?? null,
    },
  };
}

export class LocklessControllerSession {
  private backgroundInterval: ReturnType<typeof setInterval> | null = null;
  private backgroundWork: Promise<void> = Promise.resolve();
  private controllerInstanceId: ControllerInstanceId | null = null;
  private eventWork: Promise<void> = Promise.resolve();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatSuccessAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private stopRequested = false;
  private unsubscribeClose: (() => void) | null = null;
  private readonly repairScopes = new Set<LocklessScopeId>();
  private unsubscribeEvent: (() => void) | null = null;

  constructor(private readonly options: LocklessControllerSessionOptions) {}

  async start(): Promise<LocklessPairResult> {
    this.stopRequested = false;
    try {
      return await this.startInternal();
    } catch (error) {
      this.stopRequested = true;
      await this.cleanupTransport().catch(() => {});
      throw error;
    }
  }

  private async startInternal(): Promise<LocklessPairResult> {
    await this.options.projection.start();
    await this.options.projection.markUnsynchronized();
    for (const scopeId of this.options.projection.scopeIds()) {
      this.repairScopes.add(scopeId);
    }
    this.controllerInstanceId = await this.options.identity.loadOrCreate();
    await this.options.wire.connect();
    this.unsubscribeClose = this.options.wire.onClose?.(() => {
      void this.handleTransportLoss();
    }) ?? null;
    if (!this.options.preflightComplete) {
      const advertised = responsePayload(
        await this.options.wire.request(LOCKLESS_WIRE_OPS.listSurfaces),
      );
      const capabilities =
        advertised.capabilities &&
          typeof advertised.capabilities === "object" &&
          !Array.isArray(advertised.capabilities)
          ? record(advertised.capabilities)
          : {};
      const protocolFeatures = capabilities.protocolFeatures;
      if (
        !Array.isArray(protocolFeatures) ||
        !protocolFeatures.includes(SURF_ACE_LOCKLESS_V1_CAPABILITY)
      ) {
        throw new Error("lockless_capability_not_advertised");
      }
    }
    this.unsubscribeEvent = this.options.wire.onEvent((event) => {
      this.eventWork = this.eventWork.then(async () => {
        await this.applyEvent(event);
      }).catch(async () => {
        await this.options.projection.markUnsynchronized();
        for (const scopeId of this.options.projection.scopeIds()) {
          this.repairScopes.add(scopeId);
        }
      });
    });
    const pairRequestId = `rq_pair_${randomUUID()}`;
    let payload: Record<string, unknown>;
    let scopes: unknown[];
    try {
      const response = await this.options.wire.request(LOCKLESS_WIRE_OPS.pair, {
        controllerInstanceId: this.controllerInstanceId,
        controllerProductName: this.options.controllerProductName,
        projectionCapacityBytes: this.options.projection.capacityBytes,
        protocolFeatures: [
          SURF_ACE_LOCKLESS_V1_CAPABILITY,
          ...(this.options.protocolFeatures ?? []).filter(
            (feature) => feature !== SURF_ACE_LOCKLESS_V1_CAPABILITY,
          ),
        ],
        protocolVersion: 1,
        resume: this.options.projection.resumeState(),
        surfaceId: this.options.surfaceId,
      }, pairRequestId);
      payload = responsePayload(response);
      if (payload.mode !== "lockless") {
        throw new Error("lockless_capability_not_admitted");
      }
      if (payload.controllerInstanceId !== this.controllerInstanceId) {
        throw new Error("lockless_controller_identity_mismatch");
      }
      if (!Array.isArray(payload.scopes)) {
        throw new Error("invalid_lockless_pair_scopes");
      }
      if (!Array.isArray(payload.receiptResolutions)) {
        throw new Error("invalid_lockless_pair_receipt_resolutions");
      }
      scopes = payload.scopes;
    } catch (error) {
      throw error;
    }
    for (const scope of scopes) {
      const snapshot = scope as ConsumableScopeSnapshot;
      await this.options.projection.applySnapshot(snapshot);
      this.repairScopes.delete(snapshot.scopeId);
    }
    await this.flushAcknowledgements();
    this.backgroundInterval = setInterval(() => {
      this.backgroundWork = this.backgroundWork.then(async () => {
        await this.runBackgroundMaintenance();
      }).catch(async () => {
        await this.options.projection.markUnsynchronized();
        for (const scopeId of this.options.projection.scopeIds()) {
          this.repairScopes.add(scopeId);
        }
      });
    }, 250);
    this.lastHeartbeatSuccessAt = Date.now();
    this.heartbeatInterval = setInterval(() => {
      void this.sendHeartbeat();
    }, this.options.heartbeatIntervalMs ?? 15_000);
    return {
      capabilities: record(payload.capabilities),
      controllerInstanceId: this.controllerInstanceId,
      limits: record(payload.limits) as LocklessPairResult["limits"],
      mode: "lockless" as const,
      receiptResolutions:
        payload.receiptResolutions as LocklessPairResult["receiptResolutions"],
      resumed: payload.resumed === true,
      scopes: scopes as ConsumableScopeSnapshot[],
      sessionId: String(payload.sessionId),
      state: payload.state ?? null,
      surfaceId: typeof payload.surfaceId === "string"
        ? payload.surfaceId
        : null,
      surfaceSetRevision: Number(payload.surfaceSetRevision),
    };
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.cleanupTransport();
  }

  private async cleanupTransport(): Promise<void> {
    if (this.backgroundInterval) {
      clearInterval(this.backgroundInterval);
      this.backgroundInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.unsubscribeClose?.();
    this.unsubscribeClose = null;
    this.unsubscribeEvent?.();
    this.unsubscribeEvent = null;
    await this.eventWork;
    await this.backgroundWork;
    await this.options.wire.close();
  }

  async listSurfaces(): Promise<unknown> {
    return responsePayload(
      await this.options.wire.request(LOCKLESS_WIRE_OPS.listSurfaces),
    );
  }

  async requestPublic(op: string, payload: unknown = {}): Promise<unknown> {
    return responsePayload(await this.options.wire.request(op, payload));
  }

  async push(
    surfaceId: string,
    input: LocklessContentPush,
  ): Promise<unknown> {
    return responsePayload(
      await this.options.wire.request(LOCKLESS_WIRE_OPS.contentPush, {
        surfaceId,
        ...input,
      }),
    );
  }

  async splitPane(
    surfaceId: string,
    input: LocklessPaneSplitIntent,
  ): Promise<unknown> {
    return responsePayload(
      await this.options.wire.request(LOCKLESS_WIRE_OPS.splitPane, {
        surfaceId,
        ...input,
      }),
    );
  }

  async closePane(
    surfaceId: string,
    input: LocklessPaneCloseIntent,
  ): Promise<unknown> {
    return responsePayload(
      await this.options.wire.request(LOCKLESS_WIRE_OPS.closePane, {
        surfaceId,
        ...input,
      }),
    );
  }

  async restorePane(
    surfaceId: string,
    input: LocklessPaneRestoreIntent,
  ): Promise<unknown> {
    return responsePayload(
      await this.options.wire.request(LOCKLESS_WIRE_OPS.restorePane, {
        surfaceId,
        ...input,
      }),
    );
  }

  async openSurface(input: LocklessSurfaceOpenIntent): Promise<unknown> {
    return responsePayload(
      await this.options.wire.request(LOCKLESS_WIRE_OPS.openSurface, input),
    );
  }

  async closeSurface(
    surfaceId: string,
    input: Omit<LocklessSurfaceCloseIntent, "surfaceId">,
  ): Promise<unknown> {
    return responsePayload(
      await this.options.wire.request(LOCKLESS_WIRE_OPS.closeSurface, {
        surfaceId,
        ...input,
      }),
    );
  }

  async restoreSurface(
    tombstoneId: string,
    input: Omit<LocklessSurfaceRestoreIntent, "tombstoneId">,
  ): Promise<unknown> {
    return responsePayload(
      await this.options.wire.request(LOCKLESS_WIRE_OPS.restoreSurface, {
        tombstoneId,
        ...input,
      }),
    );
  }

  async readLocal(scopeId: LocklessScopeId): Promise<LocalConsumableRead> {
    const result = await this.options.projection.readLocal(scopeId);
    if (result.cacheStatus === "unsynchronized") {
      this.repairScopes.add(scopeId);
    }
    return result;
  }

  async flushAcknowledgements(): Promise<void> {
    for (const intent of this.options.projection.pendingAcknowledgements()) {
      const response = await this.options.wire.request(
        LOCKLESS_WIRE_OPS.acknowledge,
        {
          cursor: intent.cursor,
          gapGeneration: intent.gapGeneration,
          scopeId: intent.scopeId,
        } satisfies LocklessConsumableAck,
        `rq_ack_${Buffer.from(intent.idempotencyKey).toString("base64url")}`,
      );
      const payload = responsePayload(response);
      if (Number(payload.acceptedCursor) < intent.cursor) {
        throw new Error("lockless_ack_not_accepted");
      }
      await this.options.projection.confirmAcknowledgement(
        intent.idempotencyKey,
      );
      if (this.options.projection.canRearmAlert(intent.scopeId)) {
        this.options.onConsumableAcknowledged?.(intent.scopeId);
      }
    }
  }

  private async applyEvent(event: ControllerWireEnvelope): Promise<void> {
    const payload = record(event.payload);
    switch (event.op) {
      case LOCKLESS_WIRE_OPS.scopeSnapshot:
        await this.options.projection.applySnapshot(
          payload.snapshot as ConsumableScopeSnapshot,
        );
        return;
      case LOCKLESS_WIRE_OPS.consumableDelta:
        await this.options.projection.applyDelta(
          payload.scopeId as LocklessScopeId,
          payload.records as ConsumableRecord[],
        );
        return;
      case LOCKLESS_WIRE_OPS.consumableOverflow:
        await this.options.projection.applyGap(
          payload.scopeId as LocklessScopeId,
          payload.gap as ConsumableGap,
          Number(payload.firstRetainedSequence),
        );
        this.options.onConsumableAvailable?.(
          payload.scopeId as LocklessScopeId,
        );
        return;
      case LOCKLESS_WIRE_OPS.consumableAvailable:
        this.repairScopes.add(payload.scopeId as LocklessScopeId);
        this.options.onConsumableAvailable?.(
          payload.scopeId as LocklessScopeId,
        );
        return;
    }
  }

  private async runBackgroundMaintenance(): Promise<void> {
    const scopeIds = [...this.repairScopes];
    if (scopeIds.length > 0) {
      const payload = responsePayload(
        await this.options.wire.request(LOCKLESS_WIRE_OPS.consumableSync, {
          scopeIds,
        }),
      );
      const snapshots = payload.snapshots;
      if (!Array.isArray(snapshots)) {
        throw new Error("invalid_lockless_sync_snapshots");
      }
      for (const snapshot of snapshots) {
        const typedSnapshot = snapshot as ConsumableScopeSnapshot;
        await this.options.projection.applySnapshot(typedSnapshot);
        this.repairScopes.delete(typedSnapshot.scopeId);
      }
    }
    await this.flushAcknowledgements();
  }

  private async sendHeartbeat(): Promise<void> {
    if (
      Date.now() - this.lastHeartbeatSuccessAt >=
        (this.options.heartbeatTimeoutMs ?? 45_000)
    ) {
      this.options.wire.abort?.();
      await this.handleTransportLoss();
      return;
    }
    try {
      const nonce = `hb_${Date.now()}`;
      const payload = responsePayload(
        await this.options.wire.request("heartbeat.ping", { nonce }),
      );
      if (payload.nonce !== nonce) {
        throw new Error("lockless_heartbeat_nonce_mismatch");
      }
      this.lastHeartbeatSuccessAt = Date.now();
    } catch {
      if (
        Date.now() - this.lastHeartbeatSuccessAt >=
          (this.options.heartbeatTimeoutMs ?? 45_000)
      ) {
        this.options.wire.abort?.();
        await this.handleTransportLoss();
      }
    }
  }

  private async handleTransportLoss(): Promise<void> {
    if (this.stopRequested || this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    if (this.backgroundInterval) {
      clearInterval(this.backgroundInterval);
      this.backgroundInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.unsubscribeEvent?.();
    this.unsubscribeEvent = null;
    this.unsubscribeClose?.();
    this.unsubscribeClose = null;
    await this.options.projection.markUnsynchronized().catch(() => {});
    for (const scopeId of this.options.projection.scopeIds()) {
      this.repairScopes.add(scopeId);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(
    delayMs = this.options.reconnectInitialDelayMs ?? 2_000,
  ): void {
    if (this.stopRequested || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect(delayMs);
    }, delayMs);
  }

  private async reconnect(previousDelayMs: number): Promise<void> {
    try {
      await this.startInternal();
      this.reconnecting = false;
    } catch {
      await this.cleanupTransport().catch(() => {});
      this.scheduleReconnect(Math.min(previousDelayMs * 2, 30_000));
    }
  }
}
