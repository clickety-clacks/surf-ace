import type {
  LocklessContentPush,
  LocklessPaneCloseIntent,
  LocklessPaneRestoreIntent,
  LocklessPaneSplitIntent,
  LocklessPairPayload,
  LocklessScopeId,
  LocklessSurfaceCloseIntent,
  LocklessSurfaceOpenIntent,
  LocklessSurfaceRestoreIntent,
} from "@surf-ace/protocol";

import type { ControllerIdentity } from "./identity.js";
import type {
  BoundedControllerProjection,
  LocalConsumableRead,
} from "./projection.js";
import {
  LocklessControllerSession,
  type ControllerWire,
} from "./session.js";

export type MultiSurfaceControllerOptions = {
  controllerProductName: string;
  createProjection(scopeKey: string): BoundedControllerProjection;
  createWire(): ControllerWire;
  identity: ControllerIdentity;
  onConsumableAvailable?: (
    surfaceId: string,
    scopeId: LocklessScopeId,
  ) => void;
  onConsumableAcknowledged?: (
    surfaceId: string,
    scopeId: LocklessScopeId,
  ) => void;
  prepareMigration?: (surfaceId: string) => Promise<{
    accept(): Promise<void>;
    material: NonNullable<LocklessPairPayload["migrationMaterial"]>;
    reject(): Promise<void>;
  } | null>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class MultiSurfaceController {
  private lifecycle: LocklessControllerSession | null = null;
  private readonly surfaces =
    new Map<string, LocklessControllerSession>();

  constructor(private readonly options: MultiSurfaceControllerOptions) {}

  async start(): Promise<void> {
    if (this.lifecycle) {
      return;
    }
    const lifecycle = this.createSession("lifecycle");
    try {
      await lifecycle.start();
      this.lifecycle = lifecycle;
      await this.refreshSurfaceSessions();
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.surfaces.values()].map(async (session) => {
        await session.stop();
      }),
    );
    this.surfaces.clear();
    await this.lifecycle?.stop();
    this.lifecycle = null;
  }

  async listSurfaces(): Promise<unknown> {
    await this.refreshSurfaceSessions();
    return await this.requireLifecycle().listSurfaces();
  }

  surfaceSession(surfaceId: string): LocklessControllerSession {
    const session = this.surfaces.get(surfaceId);
    if (!session) {
      throw new Error(`unknown_lockless_surface:${surfaceId}`);
    }
    return session;
  }

  async push(surfaceId: string, input: LocklessContentPush): Promise<unknown> {
    return await this.surfaceSession(surfaceId).push(surfaceId, input);
  }

  async splitPane(
    surfaceId: string,
    input: LocklessPaneSplitIntent,
  ): Promise<unknown> {
    return await this.surfaceSession(surfaceId).splitPane(surfaceId, input);
  }

  async closePane(
    surfaceId: string,
    input: LocklessPaneCloseIntent,
  ): Promise<unknown> {
    return await this.surfaceSession(surfaceId).closePane(surfaceId, input);
  }

  async restorePane(
    surfaceId: string,
    input: LocklessPaneRestoreIntent,
  ): Promise<unknown> {
    return await this.surfaceSession(surfaceId).restorePane(surfaceId, input);
  }

  async openSurface(input: LocklessSurfaceOpenIntent): Promise<unknown> {
    const result = await this.requireLifecycle().openSurface(input);
    await this.refreshSurfaceSessions();
    return result;
  }

  async closeSurface(
    surfaceId: string,
    input: Omit<LocklessSurfaceCloseIntent, "surfaceId">,
  ): Promise<unknown> {
    const session = this.surfaceSession(surfaceId);
    const result = await session.closeSurface(surfaceId, input);
    this.surfaces.delete(surfaceId);
    await session.stop();
    return result;
  }

  async restoreSurface(
    tombstoneId: string,
    input: Omit<LocklessSurfaceRestoreIntent, "tombstoneId">,
  ): Promise<unknown> {
    const result = await this.requireLifecycle().restoreSurface(
      tombstoneId,
      input,
    );
    await this.refreshSurfaceSessions();
    return result;
  }

  async readLocal(scopeId: LocklessScopeId): Promise<LocalConsumableRead> {
    for (const [surfaceId, session] of this.surfaces) {
      const encoded = encodeURIComponent(surfaceId);
      if (
        scopeId === `surface:${encoded}` ||
        scopeId.startsWith(`pane:${encoded}:`)
      ) {
        return await session.readLocal(scopeId);
      }
    }
    throw new Error(`unknown_lockless_scope:${scopeId}`);
  }

  async flushAcknowledgements(): Promise<void> {
    await Promise.all(
      [...this.surfaces.values()].map(async (session) => {
        await session.flushAcknowledgements();
      }),
    );
  }

  async requestSurface(
    surfaceId: string,
    op: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    return await this.surfaceSession(surfaceId).requestPublic(op, {
      ...payload,
      surfaceId,
    });
  }

  async requestLifecycle(
    op: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    return await this.requireLifecycle().requestPublic(op, payload);
  }

  async refreshSurfaceSessions(): Promise<void> {
    const lifecycle = this.requireLifecycle();
    const listed = record(await lifecycle.listSurfaces());
    const surfaces = Array.isArray(listed.surfaces) ? listed.surfaces : [];
    const liveIds = new Set(
      surfaces.map((surface) => String(record(surface).surfaceId)),
    );
    for (const [surfaceId, session] of this.surfaces) {
      if (!liveIds.has(surfaceId)) {
        await session.stop();
        this.surfaces.delete(surfaceId);
      }
    }
    for (const surfaceId of liveIds) {
      if (!surfaceId || this.surfaces.has(surfaceId)) {
        continue;
      }
      const session = this.createSession(`surface:${surfaceId}`, surfaceId);
      await session.start();
      this.surfaces.set(surfaceId, session);
    }
  }

  private createSession(
    scopeKey: string,
    surfaceId?: string,
  ): LocklessControllerSession {
    return new LocklessControllerSession({
      controllerProductName: this.options.controllerProductName,
      identity: this.options.identity,
      onConsumableAvailable: surfaceId
        ? (scopeId) => {
            this.options.onConsumableAvailable?.(surfaceId, scopeId);
          }
        : undefined,
      onConsumableAcknowledged: surfaceId
        ? (scopeId) => {
            this.options.onConsumableAcknowledged?.(surfaceId, scopeId);
          }
        : undefined,
      projection: this.options.createProjection(scopeKey),
      prepareMigration: surfaceId
        ? async () => await this.options.prepareMigration?.(surfaceId) ?? null
        : undefined,
      surfaceId,
      wire: this.options.createWire(),
    });
  }

  private requireLifecycle(): LocklessControllerSession {
    if (!this.lifecycle) {
      throw new Error("lockless_controller_not_started");
    }
    return this.lifecycle;
  }
}
