import { randomBytes, randomUUID } from "node:crypto";

import { parseHTML } from "linkedom";

import type {
  AnnotationCommittedEvent,
  AuthorityPaneIdentity,
  ContentApplyRequest,
  ContentApplyResponse,
  ContentAppendRequest,
  ContentClearRequest,
  ContentPatchRequest,
  ContentReloadSource,
  ContentSetRequest,
  ContentType,
  DrawingFlushConfig,
  DrawingFlushEvent,
  EpochMs,
  HistoryNavigatedEvent,
  MutationAckResponse,
  NativePaneWindowGroupDiagnostic,
  PaneCloseResponse,
  PaneCreatedEvent,
  PaneId,
  PaneRemovedEvent,
  PaneRenamedEvent,
  PairResponse,
  PaneCurrentTargetState,
  PanesListResponse,
  PaneGeometryProjection,
  Position,
  Revision,
  Rect,
  Selection,
  SnapshotResponse,
  Stroke,
  StrokeId,
  SurfaceId,
  SurfaceViewport,
  TargetApplyRequest,
  TargetApplyResponse,
  TargetMaterializedState,
  TopologyApplyRequest,
  TopologyApplyResponse,
  TopologyRevision,
} from "../../protocol/src/index.js";
import type { NativePaneChromeInsets, NativePaneMaterialization } from "./native-pane-bridge.js";
import type { NativePaneWindowGroupStatus } from "./native-pane-bridge.js";
import {
  LocklessAuthorityError,
  LocklessClientAuthority,
  type PersistentLocklessClientState,
} from "./lockless-client-authority.js";
import {
  locklessPaneScopeId,
  locklessSurfaceScopeId,
  type LocklessContentCommit,
  type LocklessContentPush,
  type LocklessEntryProvenance,
  type LocklessPairPayload,
} from "../../protocol/src/lockless.js";
import { cloneWindowPlacement, type WindowPlacement } from "./window-placement.js";

type ContentPayload = ContentSetRequest["payload"]["content"];
type ContentDisplay = ContentSetRequest["payload"]["display"];
type BrowserUrlPayload = { url: string };
type RenderableContentType = ContentType | "browser_url";
type RenderablePayload = ContentPayload | BrowserUrlPayload;

type HistoryEntry = {
  annotations: Stroke[];
  content: RenderablePayload | null;
  contentId: string | null;
  contentType: RenderableContentType | null;
  display?: ContentDisplay;
  historyEntryId?: string;
  lastVisibleSequence?: number;
  lastApplyEvidence?: TargetApplyResponse["payload"];
  ownerToken: string | null;
  provenance?: LocklessEntryProvenance;
  registeredTarget?: PaneCurrentTargetState & {
    idempotencyKey: string;
    launchedAt: string;
    registrationState: "before_attach" | "attached";
  };
  reloadSource?: ContentReloadSource;
  revision: number;
};

function persistedHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return structuredClone(entry);
}

type PaneSnapshot = {
  bounds: { height: number; width: number; x: number; y: number } | null;
  geometryRevision: number | null;
  selection: Selection;
  surfaceEpoch: string | null;
  topologyRevision: number | null;
  viewport: SnapshotResponse["payload"]["viewport"];
  visibleText: string;
};

type PaneState = {
  annotating: boolean;
  annotationFrameOpen: boolean;
  deliveredClosedFrameCount: number;
  dirtyStrokeIds: string[];
  externalNative: boolean;
  firstDirtyStrokeAt: number | null;
  flushInFlight: boolean;
  history: HistoryEntry[];
  historyIndex: number;
  lastDirtyStrokeAt: number | null;
  lastSuccessfulFlushAt: number | null;
  latestContentEventAt: number;
  name: string | null;
  nextRevision: number;
  nativeHost: {
    bindingId?: string;
    contentId?: string;
    launchToken?: string;
    revision: Revision;
  } | null;
  nativeWindowGroup: NativePaneWindowGroupDiagnostic | null;
  paneId: number;
  paneLabel: number;
  paneLineageId: string;
  pendingAnnotationCommit: boolean;
  snapshot: PaneSnapshot;
  toast: string | null;
};

const NATIVE_PANE_CHROME_REACHABILITY_INSETS: NativePaneChromeInsets = {
  bottom: 44,
  left: 44,
  right: 44,
  top: 44,
};

type LayoutNode =
  | {
      paneId: number;
      type: "pane";
      weight?: number;
    }
  | {
      children: LayoutNode[];
      direction: "horizontal" | "vertical";
      type: "split";
      weight?: number;
    };

type SurfaceState = {
  activeKeyboardPaneId: number | null;
  connectionBar: "connected" | "connecting" | "disconnected";
  geometryRevision: number;
  layout: LayoutNode | null;
  name: string;
  paneOrder: number[];
  panes: Map<number, PaneState>;
  providerOwnership: PersistentProviderOwnership | null;
  providerName: string | null;
  surfaceId: string;
  surfaceEpoch: string;
  surfaceEpochRevision: number;
  topologyRevision: number;
  viewport: SurfaceViewport;
  windowPlacement: WindowPlacement | null;
  windowLabel: string;
};

export type PersistentProviderOwnership = {
  ownershipEpoch: number;
  providerId: string;
  sessionId: string;
};

type BrowserUrlTargetValidation =
  | {
      pane: PaneState;
      url: URL;
    }
  | {
      result: TargetApplyResponse["payload"];
    };

const TERMINAL_HOST_EXECUTABLES = new Set(["alacritty", "foot", "ghostty", "kitty", "wezterm"]);
const DIRECT_NATIVE_PANE_EXECUTABLES = new Set(["galculator", "kolourpaint", "weston-simple-egl"]);
const DIRECT_NATIVE_PANE_EXECUTABLE_ENV = new Map<string, Record<string, string>>([
  ["kolourpaint", { QT_QPA_PLATFORM: "wayland" }],
]);

export type PaneNavigationDirection = "down" | "left" | "right" | "up";

export type PersistentSurfaceState = {
  lockless?: PersistentLocklessClientState;
  primarySurfaceId: string | null;
  surfaces?: PersistentSurfaceRecord[];
  version: 1;
};

type PersistentSurfaceRecord = {
  activeKeyboardPaneId: number | null;
  geometryRevision: number;
  layout: LayoutNode | null;
  name: string;
  paneOrder: number[];
  panes: PersistentPaneRecord[];
  providerOwnership?: PersistentProviderOwnership | null;
  surfaceEpochRevision: number;
  surfaceId: string;
  topologyRevision: number;
  viewport: SurfaceViewport;
  windowPlacement?: WindowPlacement | null;
  windowLabel: string;
};

type PersistentPaneRecord = {
  annotating: boolean;
  annotationFrameOpen: boolean;
  deliveredClosedFrameCount: number;
  dirtyStrokeIds: string[];
  externalNative: boolean;
  firstDirtyStrokeAt: number | null;
  flushInFlight: boolean;
  history: HistoryEntry[];
  historyIndex: number;
  lastDirtyStrokeAt: number | null;
  lastSuccessfulFlushAt: number | null;
  latestContentEventAt: number;
  name: string | null;
  nextRevision?: number;
  paneId: number;
  paneLabel: number;
  paneLineageId: string;
  pendingAnnotationCommit: boolean;
  snapshot: PaneSnapshot;
  toast: string | null;
};

export type RendererPaneState = {
  activeKeyboardPane: boolean;
  annotationBorderVisible: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  content: {
    content: RenderablePayload | null;
    contentId: string | null;
    contentType: RenderableContentType | null;
    display?: ContentDisplay;
    reloadable: boolean;
    reloadSource?: ContentReloadSource;
    renderVersion: number;
    revision: number;
  };
  drawings: Stroke[];
  externalNative: boolean;
  flushInFlight: boolean;
  label: string;
  name: string | null;
  ownerName: string | null;
  paneId: number;
  displayId: string;
  provenanceName: string | null;
  provenance: LocklessEntryProvenance | null;
  visibleAddress: string;
  showDone: boolean;
  toast: string | null;
};

export type RendererWindowState = {
  connectionBar: SurfaceState["connectionBar"];
  layout: LayoutNode | null;
  name: string;
  panes: RendererPaneState[];
  providerName: string | null;
  surfaceId: string;
  geometryRevision: number;
  surfaceEpoch: string;
  topologyRevision: number;
  viewport: SurfaceViewport;
  windowLabel: string;
};

export type ResolvedPaneGeometryIdentity = {
  geometryRevision: number;
  surfaceEpoch: string;
  topologyRevision: number;
};

export type ReloadEntryIdentity = {
  contentId: string | null;
  contentType: RenderableContentType | null;
  reloadSource: ContentReloadSource;
  renderVersion: number;
  revision: number;
};

export type CoreEvent =
  | { type: "lockless-authority-changed" }
  | { surfaceId: string; type: "surface-changed" }
  | { surfaceId: string; type: "surface-created" }
  | { surfaceId: string; type: "surface-removed" }
  | { paneIds: number[]; surfaceId: string; type: "pane-geometry-changed" }
  | { fromSplit: boolean; paneId: number; paneLabel: number; parentPaneId: number | null; surfaceId: string; type: "pane-created" }
  | { paneId: number; surfaceId: string; type: "pane-removed" }
  | { name: string | null; paneId: number; surfaceId: string; type: "pane-renamed" }
  | { paneId: number; surfaceId: string; type: "annotation-committed" }
  | { contentId: string | null; direction: "back" | "forward"; paneId: number; revision: number; surfaceId: string; type: "history-navigated" }
  | { surfaceId: string; type: "topology-changed" }
  | { paneId: number; surfaceId: string; type: "drawing-dirty" };

export class SurfaceCoreError extends Error {
  constructor(
    readonly code:
      | "busy"
      | "content_too_large"
      | "internal_error"
      | "invalid_resume"
      | "invalid_operation"
      | "invalid_payload"
      | "missing_provider_name"
      | "not_lock_owner"
      | "not_paired"
      | "render_failed"
      | "stale_content"
      | "stale_revision"
      | "unsupported_content_type"
      | "unsupported_operation_for_content_type",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SurfaceCoreError";
  }
}

export function isValidWindowLabel(windowLabel: unknown): windowLabel is string {
  return typeof windowLabel === "string" && /^[a-z]+$/.test(windowLabel);
}

export function assertValidWindowLabel(windowLabel: unknown): asserts windowLabel is string {
  if (!isValidWindowLabel(windowLabel)) {
    throw new SurfaceCoreError("invalid_payload", "windowLabel must be a lowercase alphabetic provider identity label");
  }
}

function visiblePaneAddress(windowLabel: string, paneLabel: number): string {
  void windowLabel;
  return paneLabel > 0 ? String(paneLabel) : "";
}

function alphabeticLabel(ordinal: number): string {
  let remaining = Math.max(1, Math.trunc(ordinal));
  let result = "";
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

function provenanceDisplayName(display: ContentDisplay | undefined): string | null {
  return display?.senderDisplayName ??
    display?.provenance?.displayName ??
    display?.provenance?.streamLabel ??
    display?.provenance?.sessionKey ??
    null;
}

const DEFAULT_VISIBLE_RECT = { height: 768, width: 1024, x: 0, y: 0 };
const MAX_HISTORY_DEPTH = 20;
const BOOTSTRAP_PANE_ID = 0;
const SUPPORTED_CONTENT_TYPES: ContentType[] = [
  "html",
  "image",
  "pdf",
  "terminal",
  "markdown",
];
const SUPPORTED_TARGET_CAPABILITIES = [
  "target.browser_url.v1",
] as const;

export class SurfaceCore {
  readonly locklessAuthority: LocklessClientAuthority;
  private readonly surfaces = new Map<string, SurfaceState>();
  private readonly listeners = new Set<(event: CoreEvent) => void>();
  private pendingEvents: CoreEvent[] | null = null;
  private readonly logger: { warn?: (message: string) => void };
  private readonly now: () => number;
  private persistentState: PersistentSurfaceState;

  constructor(options?: {
    clientIdentity?: string;
    logger?: { warn?: (message: string) => void };
    now?: () => number;
    persistentState?: PersistentSurfaceState;
  }) {
    this.logger = options?.logger ?? console;
    this.now = options?.now ?? (() => Date.now());
    this.persistentState = options?.persistentState ?? {
      primarySurfaceId: null,
      version: 1,
    };
    this.locklessAuthority = new LocklessClientAuthority(
      this.persistentState.lockless,
      this.now,
      options?.clientIdentity ?? null,
    );
  }

  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  transaction<T>(operation: () => T): T {
    if (this.pendingEvents) return operation();
    this.pendingEvents = [];
    try {
      const result = operation();
      const events = this.pendingEvents;
      this.pendingEvents = null;
      for (const event of events) this.deliver(event);
      return result;
    } catch (error) {
      this.pendingEvents = null;
      throw error;
    }
  }

  getPersistentState(): PersistentSurfaceState {
    return {
      ...structuredClone(this.persistentState),
      lockless: this.locklessAuthority.exportState(),
      surfaces: this.listSurfaces().map((surface) => serializeSurface(surface)),
    };
  }

  markLocklessAuthorityChanged(surfaceId?: string): void {
    this.emit({ type: "lockless-authority-changed" });
    const targetSurfaceId =
      surfaceId ??
      this.persistentState.primarySurfaceId ??
      this.listSurfaces()[0]?.surfaceId;
    if (targetSurfaceId) {
      this.emit({ surfaceId: targetSurfaceId, type: "surface-changed" });
    }
  }

  admitSurfaceToLockless(
    surfaceId: string,
    migrationMaterial?: LocklessPairPayload["migrationMaterial"],
    controllerInstanceId?: string,
  ): void {
    if (this.locklessAuthority.surfaceMode(surfaceId) === "lockless") {
      if (migrationMaterial) {
        throw new LocklessAuthorityError(
          "invalid_operation",
          "Legacy migration material is accepted only during first lockless admission",
        );
      }
      return;
    }
    const surface = this.getSurface(surfaceId);
    const rollback = serializeSurface(surface);
    const hadLegacyOwnership = surface.providerOwnership !== null;
    const usedLabels = new Set<number>();
    let nextLabel = 1;
    try {
      surface.providerOwnership = null;
      const bootstrapPane = surface.panes.get(BOOTSTRAP_PANE_ID);
      if (
        surface.panes.size === 1 &&
        surface.layout?.type === "pane" &&
        surface.layout.paneId === BOOTSTRAP_PANE_ID &&
        bootstrapPane &&
        isPristineProviderBootstrapPane(bootstrapPane, true)
      ) {
        const identity = this.locklessAuthority.allocatePaneIdentity([], []);
        this.ensureInitialPane(
          surface,
          identity.paneId,
          identity.paneLabel,
        );
      }
      if (!isValidWindowLabel(surface.windowLabel)) {
        const usedWindowLabels = new Set(
          this.listSurfaces()
            .filter((candidate) => candidate.surfaceId !== surfaceId)
            .map((candidate) => candidate.windowLabel)
            .filter(isValidWindowLabel),
        );
        let ordinal = 1;
        let candidate = alphabeticLabel(ordinal);
        while (usedWindowLabels.has(candidate)) {
          candidate = alphabeticLabel(++ordinal);
        }
        surface.windowLabel = candidate;
      }
      for (const paneId of surface.paneOrder) {
        const pane = surface.panes.get(paneId)!;
        if (pane.paneLabel <= 0 || usedLabels.has(pane.paneLabel)) {
          while (usedLabels.has(nextLabel)) nextLabel += 1;
          pane.paneLabel = nextLabel;
        }
        usedLabels.add(pane.paneLabel);
      }
      const prospective = serializeSurface(surface);
      const surfaceBase = ({
        panes: _panes,
        ...base
      }: PersistentSurfaceRecord) => base;
      this.locklessAuthority.assertSurfaceRecoverableBaseCapacity(
        surfaceBase(rollback),
        surfaceBase(prospective),
      );
      for (const pane of prospective.panes) {
        this.locklessAuthority.assertPaneRecoverableCapacity(
          rollback.panes.find((entry) => entry.paneId === pane.paneId) ?? pane,
          pane,
          pane.history.map((entry) => entry.annotations),
        );
      }
      const retainedPaneCount = this.locklessAuthority
        .listTombstones("pane")
        .filter((entry) => entry.surfaceId === surfaceId).length;
      if (
        surface.panes.size + retainedPaneCount >
        this.locklessAuthority.limits.maxPanesPerSurface +
          this.locklessAuthority.limits.maxRetainedTombstones
      ) {
        throw new LocklessAuthorityError(
          "pane_capacity",
          "Legacy surface exceeds lockless live-plus-tombstone envelope",
        );
      }
      if (hadLegacyOwnership && !migrationMaterial) {
        throw new LocklessAuthorityError(
          "capability_mismatch",
          "Legacy provider-local unread state requires explicit migration material",
        );
      }
      if (migrationMaterial) {
        if (!controllerInstanceId) {
          throw new LocklessAuthorityError(
            "invalid_controller_instance",
            "Legacy migration requires the stable controller instance",
          );
        }
        const admittedScopeIds = new Set([
          locklessSurfaceScopeId(surfaceId),
          ...this.activePaneIds(surfaceId).map((paneId) =>
            locklessPaneScopeId(surfaceId, paneId),
          ),
          ...this.locklessAuthority
            .retainedPaneIds(surfaceId)
            .map((paneId) => locklessPaneScopeId(surfaceId, paneId)),
        ]);
        const foreignScope = migrationMaterial.scopes.find(
          (candidate) => !admittedScopeIds.has(candidate.scopeId),
        );
        if (foreignScope) {
          throw new LocklessAuthorityError(
            "invalid_payload",
            "Legacy migration scope does not belong to the paired surface",
            { scopeId: foreignScope.scopeId, surfaceId },
          );
        }
        this.locklessAuthority.importLegacyMigrationMaterial(
          controllerInstanceId,
          migrationMaterial,
        );
      }
      this.locklessAuthority.convertSurfaceToLocklessMode(surfaceId);
      this.emit({ surfaceId, type: "surface-changed" });
    } catch (error) {
      const restored = deserializeSurface(rollback, this.now());
      if (restored) {
        this.surfaces.set(surfaceId, restored);
      }
      throw error;
    }
  }

  getWindowPlacement(surfaceId: string): WindowPlacement | null {
    return cloneWindowPlacement(this.getSurface(surfaceId).windowPlacement);
  }

  getProviderOwnership(surfaceId: string): PersistentProviderOwnership | null {
    const ownership = this.getSurface(surfaceId).providerOwnership;
    return ownership ? structuredClone(ownership) : null;
  }

  setProviderOwnership(surfaceId: string, ownership: PersistentProviderOwnership): void {
    const surface = this.getSurface(surfaceId);
    surface.providerOwnership = {
      ownershipEpoch: Math.max(1, Math.trunc(Number(ownership.ownershipEpoch))),
      providerId: ownership.providerId,
      sessionId: ownership.sessionId,
    };
    this.emit({ surfaceId, type: "surface-changed" });
  }

  clearProviderOwnership(surfaceId: string): void {
    const surface = this.getSurface(surfaceId);
    if (surface.providerOwnership === null) {
      return;
    }
    surface.providerOwnership = null;
    this.emit({ surfaceId, type: "surface-changed" });
  }

  setWindowPlacement(surfaceId: string, placement: WindowPlacement | null): void {
    const surface = this.getSurface(surfaceId);
    const nextPlacement = cloneWindowPlacement(placement);
    if (JSON.stringify(surface.windowPlacement) === JSON.stringify(nextPlacement)) {
      return;
    }
    surface.windowPlacement = nextPlacement;
    this.emit({ surfaceId, type: "surface-changed" });
  }

  ensurePrimarySurface(name: string, viewport: SurfaceViewport): SurfaceState {
    const existingId = this.persistentState.primarySurfaceId;
    if (existingId && this.surfaces.has(existingId)) {
      const existing = this.surfaces.get(existingId)!;
      existing.name = name;
      existing.viewport = cloneViewport(viewport);
      existing.connectionBar = "disconnected";
      existing.providerName = null;
      this.emit({ surfaceId: existing.surfaceId, type: "surface-changed" });
      return existing;
    }

    const retainedSurfaceIds = new Set(
      this.locklessAuthority
        .listTombstones("surface")
        .map((entry) => entry.surfaceId),
    );
    const surfaceId =
      existingId && !retainedSurfaceIds.has(existingId)
        ? existingId
        : `sf_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const surface = this.createSurface(surfaceId, name, viewport);
    this.persistentState.primarySurfaceId = surface.surfaceId;
    return surface;
  }

  createAdditionalSurface(name: string, viewport: SurfaceViewport): SurfaceState {
    return this.createSurface(
      `sf_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      name,
      viewport,
    );
  }

  createLocklessSurface(
    name: string,
    viewport: SurfaceViewport,
  ): SurfaceState {
    const surface = this.createAdditionalSurface(name, viewport);
    try {
      const identity = this.locklessAuthority.allocatePaneIdentity([], []);
      this.applyProviderBootstrapTopology(surface.surfaceId, {
        initialPaneId: identity.paneId,
        initialPaneLabel: identity.paneLabel,
        windowLabel: surface.windowLabel,
      });
      this.admitSurfaceToLockless(surface.surfaceId);
      return surface;
    } catch (error) {
      this.surfaces.delete(surface.surfaceId);
      throw error;
    }
  }

  captureSurfaceTombstonePayload(
    surfaceId: string,
  ): PersistentSurfaceRecord {
    return serializeSurface(this.getSurface(surfaceId));
  }

  captureSurfaceRecoverableBase(
    surfaceId: string,
  ): Omit<PersistentSurfaceRecord, "panes"> {
    const { panes: _panes, ...base } = serializeSurface(
      this.getSurface(surfaceId),
    );
    return base;
  }

  restoreSurfaceTombstone(
    record: PersistentSurfaceRecord,
  ): SurfaceState {
    if (this.surfaces.has(record.surfaceId)) {
      throw new SurfaceCoreError(
        "invalid_operation",
        `Surface is already live: ${record.surfaceId}`,
      );
    }
    const prospective = structuredClone(record);
    const usedWindowLabels = new Set(
      this.listSurfaces().map((surface) => surface.windowLabel),
    );
    if (
      !isValidWindowLabel(prospective.windowLabel) ||
      usedWindowLabels.has(prospective.windowLabel)
    ) {
      let ordinal = 1;
      let candidate = alphabeticLabel(ordinal);
      while (usedWindowLabels.has(candidate)) {
        candidate = alphabeticLabel(++ordinal);
      }
      prospective.windowLabel = candidate;
    }
    const surface = deserializeSurface(prospective, this.now());
    if (!surface) {
      throw new SurfaceCoreError(
        "invalid_payload",
        "Surface tombstone payload is invalid",
      );
    }
    surface.providerOwnership = null;
    this.surfaces.set(surface.surfaceId, surface);
    this.emit({ surfaceId: surface.surfaceId, type: "surface-created" });
    this.emit({ surfaceId: surface.surfaceId, type: "surface-changed" });
    return surface;
  }

  restorePersistedSurfaces(name: string, viewport: SurfaceViewport): SurfaceState[] {
    const records = Array.isArray(this.persistentState.surfaces)
      ? this.persistentState.surfaces
      : [];
    const restored: SurfaceState[] = [];
    for (const record of records) {
      if (!record || typeof record.surfaceId !== "string" || this.surfaces.has(record.surfaceId)) {
        continue;
      }
      const surface = deserializeSurface(record, this.now());
      if (!surface) {
        continue;
      }
      if (surface.surfaceId === this.persistentState.primarySurfaceId) {
        surface.name = name;
        surface.viewport = cloneViewport(viewport);
      }
      this.surfaces.set(surface.surfaceId, surface);
      restored.push(surface);
      this.emit({ surfaceId: surface.surfaceId, type: "surface-created" });
      this.emit({ surfaceId: surface.surfaceId, type: "surface-changed" });
    }
    if (
      restored.length > 0 &&
      !restored.some((surface) => surface.surfaceId === this.persistentState.primarySurfaceId)
    ) {
      this.persistentState.primarySurfaceId = restored[0]!.surfaceId;
    }
    return restored;
  }

  removeSurface(surfaceId: string): void {
    if (!this.surfaces.has(surfaceId)) {
      return;
    }
    this.surfaces.delete(surfaceId);
    this.emit({ surfaceId, type: "surface-removed" });
  }

  listSurfaces(): SurfaceState[] {
    return [...this.surfaces.values()].sort((left, right) =>
      left.windowLabel.localeCompare(right.windowLabel, "en"),
    );
  }

  getSurface(surfaceId: string): SurfaceState {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) {
      throw new SurfaceCoreError("invalid_payload", `Unknown surface: ${surfaceId}`);
    }
    return surface;
  }

  resolvedPaneGeometryIdentity(surfaceId: string): ResolvedPaneGeometryIdentity {
    const surface = this.getSurface(surfaceId);
    return {
      geometryRevision: surface.geometryRevision,
      surfaceEpoch: surface.surfaceEpoch,
      topologyRevision: surface.topologyRevision,
    };
  }

  captureSurfaceMutationRollback(surfaceId: string): () => void {
    const snapshot = structuredClone(this.getSurface(surfaceId));
    return () => {
      this.surfaces.set(surfaceId, structuredClone(snapshot));
    };
  }

  setConnectionBar(surfaceId: string, state: SurfaceState["connectionBar"]): void {
    const surface = this.getSurface(surfaceId);
    if (surface.connectionBar === state && (state === "connected" || surface.providerName === null)) {
      return;
    }
    surface.connectionBar = state;
    if (state !== "connected") {
      surface.providerName = null;
    }
    this.emit({ surfaceId, type: "surface-changed" });
  }

  setProviderName(surfaceId: string, providerName: string | null): void {
    const surface = this.getSurface(surfaceId);
    if (surface.providerName === providerName) {
      return;
    }
    surface.providerName = providerName;
    this.emit({ surfaceId, type: "surface-changed" });
  }

  getRendererWindowState(surfaceId: string): RendererWindowState {
    const surface = this.getSurface(surfaceId);
    this.ensureActiveKeyboardPane(surface);
    return {
      connectionBar: surface.connectionBar,
      layout: surface.layout ? structuredClone(surface.layout) : null,
      name: surface.name,
      panes: surface.paneOrder.map((paneId) => {
        const pane = surface.panes.get(paneId)!;
        const current = currentEntry(pane);
        return {
          activeKeyboardPane: surface.activeKeyboardPaneId === paneId,
          annotationBorderVisible: pane.annotating,
          canGoBack: pane.historyIndex > 0,
          canGoForward: pane.historyIndex < pane.history.length - 1,
          content: {
            content: cloneContent(current.content),
            contentId: current.contentId,
            contentType: current.contentType,
            display: current.display ? { ...current.display } : undefined,
            reloadable: isReloadableEntry(current, pane.externalNative),
            reloadSource: cloneReloadSource(current.reloadSource) ?? undefined,
            renderVersion: pane.latestContentEventAt,
            revision: current.revision,
          },
          drawings: structuredClone(current.annotations),
          externalNative: pane.externalNative,
          flushInFlight: pane.flushInFlight,
          label: pane.paneLabel > 0 ? String(pane.paneLabel) : "",
          name: pane.name,
          ownerName: provenanceDisplayName(current.display),
          paneId,
          displayId: visiblePaneAddress(surface.windowLabel, pane.paneLabel),
          provenanceName: provenanceDisplayName(current.display),
          provenance: current.provenance
            ? structuredClone(current.provenance)
            : null,
          visibleAddress: visiblePaneAddress(surface.windowLabel, pane.paneLabel),
          showDone: pane.annotating,
          toast: pane.toast,
        };
      }),
      providerName: surface.providerName,
      surfaceId: surface.surfaceId,
      geometryRevision: surface.geometryRevision,
      surfaceEpoch: surface.surfaceEpoch,
      topologyRevision: surface.topologyRevision,
      viewport: cloneViewport(surface.viewport),
      windowLabel: surface.windowLabel,
    };
  }

  activeKeyboardPaneId(surfaceId: string): number | null {
    const surface = this.getSurface(surfaceId);
    this.ensureActiveKeyboardPane(surface);
    return surface.activeKeyboardPaneId;
  }

  setActiveKeyboardPane(surfaceId: string, paneId: number): void {
    const surface = this.getSurface(surfaceId);
    if (!surface.panes.has(paneId) || surface.activeKeyboardPaneId === paneId) {
      return;
    }
    surface.activeKeyboardPaneId = paneId;
    this.emit({ surfaceId, type: "surface-changed" });
  }

  navigateActiveKeyboardPane(surfaceId: string, direction: PaneNavigationDirection): number | null {
    const surface = this.getSurface(surfaceId);
    this.ensureActiveKeyboardPane(surface);
    const activePaneId = surface.activeKeyboardPaneId;
    if (activePaneId === null) {
      return null;
    }
    const paneGeometry = resolvePaneGeometrySnapshots(surface);
    const active = paneGeometry.get(activePaneId)?.paneFrame;
    if (!active) {
      return null;
    }
    const nextPaneId = nearestPaneInDirection(activePaneId, active, paneGeometry, direction);
    if (nextPaneId === null || nextPaneId === activePaneId) {
      return null;
    }
    this.setActiveKeyboardPane(surfaceId, nextPaneId);
    return nextPaneId;
  }

  clearToast(surfaceId: string, paneId: number): void {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return;
    }
    if (!pane.toast) {
      return;
    }
    pane.toast = null;
    this.emit({ surfaceId, type: "surface-changed" });
  }

  setAnnotating(surfaceId: string, paneId: number, enabled: boolean): void {
    const surface = this.getSurface(surfaceId);
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return;
    }
    if (pane.annotating === enabled) {
      return;
    }
    pane.annotating = enabled;
    pane.toast = null;
    bumpGeometryRevision(surface);
    this.emit({ surfaceId, type: "surface-changed" });
    if (!enabled && pane.annotationFrameOpen) {
      pane.pendingAnnotationCommit = true;
      this.emit({ paneId, surfaceId, type: "annotation-committed" });
    }
  }

  navigateHistory(surfaceId: string, paneId: number, direction: "back" | "forward"): void {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return;
    }
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      return;
    }

    if (direction === "back" && pane.historyIndex > 0) {
      pane.historyIndex -= 1;
    } else if (direction === "forward" && pane.historyIndex < pane.history.length - 1) {
      pane.historyIndex += 1;
    } else {
      return;
    }
    if (currentEntry(pane).historyEntryId) {
      currentEntry(pane).lastVisibleSequence =
        Math.max(
          0,
          ...pane.history.map((entry) => entry.lastVisibleSequence ?? 0),
        ) + 1;
    }

    pane.toast = null;
    pane.externalNative = false;
    pane.nativeHost = null;
    pane.nativeWindowGroup = null;
    clearDirtyState(pane);
    bumpGeometryRevision(this.getSurface(surfaceId));
    this.emit({ surfaceId, type: "surface-changed" });
    this.emit({
      contentId: protocolContentId(currentEntry(pane)),
      direction,
      paneId,
      revision: currentEntry(pane).revision,
      surfaceId,
      type: "history-navigated",
    });
  }

  canNavigateHistory(surfaceId: string, paneId: number, direction: "back" | "forward"): boolean {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane || pane.annotating) {
      return false;
    }
    if (direction === "back") {
      return pane.historyIndex > 0;
    }
    return pane.historyIndex < pane.history.length - 1;
  }

  panesList(surfaceId: string): PanesListResponse["payload"] {
    const surface = this.getSurface(surfaceId);
    const paneGeometry = resolvePaneGeometrySnapshots(surface);
    return {
      panes: surface.paneOrder.map((paneId) => {
        const pane = surface.panes.get(paneId)!;
        const current = currentEntry(pane);
        const geometry = paneGeometry.get(paneId);
        if (!geometry) {
          throw new SurfaceCoreError("internal_error", `Pane ${paneId} is missing resolved geometry`);
        }
        const currentTarget = currentTargetStateForEntry(pane, current);
        return {
          activeContentId: protocolContentId(current),
          contentType: protocolContentType(current),
          ...(currentTarget ? { currentTarget } : {}),
          externalNative: pane.externalNative,
          geometry,
          name: pane.name,
          ...(pane.externalNative && pane.nativeWindowGroup
            ? { nativeWindowGroup: pane.nativeWindowGroup }
            : {}),
          paneId: pane.paneId as PaneId,
          paneLabel: pane.paneLabel,
          paneLineageId: pane.paneLineageId,
          viewport: structuredClone(geometry.protocolViewport.viewport),
        };
      }),
    };
  }

  missingResolvedPaneGeometry(
    surfaceId: string,
    paneIds: Iterable<number>,
    expectedIdentity: ResolvedPaneGeometryIdentity = this.resolvedPaneGeometryIdentity(surfaceId),
  ): number[] {
    const surface = this.getSurface(surfaceId);
    const paneGeometry = resolvePaneGeometrySnapshots(surface);
    const seen = new Set<number>();
    const missing: number[] = [];
    for (const paneId of paneIds) {
      if (seen.has(paneId)) {
        continue;
      }
      seen.add(paneId);
      const geometry = paneGeometry.get(paneId);
      if (
        !geometry ||
        geometry.geometryUnavailable ||
        geometry.geometryRevision !== expectedIdentity.geometryRevision ||
        geometry.surfaceEpoch !== expectedIdentity.surfaceEpoch ||
        geometry.topologyEpoch !== expectedIdentity.topologyRevision
      ) {
        missing.push(paneId);
      }
    }
    return missing;
  }

  projectNativePaneMaterialization(
    surfaceId: string,
    payload: TargetApplyRequest["payload"],
  ): NativePaneMaterialization {
    const surface = this.getSurface(surfaceId);
    const paneGeometry = resolvePaneGeometrySnapshots(surface);
    const lineagePane = paneForLineage(surface, payload.paneLineageId);
    if (!lineagePane) {
      throw new SurfaceCoreError("invalid_payload", "target.apply pane lineage is not present on this surface");
    }
    const geometry = paneGeometry.get(lineagePane.paneId);
    if (!geometry || geometry.geometryUnavailable) {
      throw new SurfaceCoreError("invalid_payload", `native pane ${lineagePane.paneId} has no authoritative resolved Surf Ace geometry snapshot`);
    }
    const compositorViewport = compositorResolvedRect(geometry.contentViewport);
    const launchToken = nativePaneLaunchToken(surface.surfaceId, lineagePane.paneId, payload.targetId, payload.targetEpoch);
    const paneEntry: NativePaneMaterialization["panes"][number] = {
      binding_id: `${lineagePane.paneId}:${payload.targetId}`,
      content_id: payload.targetId,
      geometry: {
        coordinateSpace: "compositor_logical",
        geometryRevision: geometry.geometryRevision,
        height: compositorViewport.height,
        paneInstanceId: geometry.paneInstanceId,
        surfaceEpoch: geometry.surfaceEpoch,
        topologyEpoch: geometry.topologyEpoch,
        width: compositorViewport.width,
        x: compositorViewport.x,
        y: compositorViewport.y,
      },
      id: String(lineagePane.paneId),
      revision: payload.targetEpoch as Revision,
      windowGroup: {
        launchIdentity: {
          launchToken,
          paneId: String(lineagePane.paneId),
          paneInstanceId: geometry.paneInstanceId,
          surfaceId: surface.surfaceId as SurfaceId,
          targetId: payload.targetId,
        },
        policy: {
          chromeInsets: NATIVE_PANE_CHROME_REACHABILITY_INSETS,
          clipToPane: true,
          constrainToPane: true,
          denyForeignToplevels: true,
          sameLaunchSecondaryToplevels: "accept",
        },
      },
    };
    if (payload.targetKind === "terminal_app" && isPlainRecord(payload.targetPayload)) {
      const { args, command, cwd, env } = payload.targetPayload;
      if (typeof command === "string") {
        const commandArgs = Array.isArray(args) && args.every((arg) => typeof arg === "string") ? [...args] : [];
        const executableName = command.split(/[\\/]/).pop() ?? command;
        const launchesDirectNativePaneProcess = DIRECT_NATIVE_PANE_EXECUTABLES.has(executableName);
        const isTerminalHost = TERMINAL_HOST_EXECUTABLES.has(executableName);
        const directNativeEnv = launchesDirectNativePaneProcess ? DIRECT_NATIVE_PANE_EXECUTABLE_ENV.get(executableName) : undefined;
        const processEnv = {
          ...(directNativeEnv ?? {}),
          ...(isPlainRecord(env) && isStringRecord(env) ? env : {}),
        };
        paneEntry.target = "terminal";
        paneEntry.process = {
          args: isTerminalHost || launchesDirectNativePaneProcess ? commandArgs : ["-e", command, ...commandArgs],
          command: isTerminalHost || launchesDirectNativePaneProcess ? command : "foot",
          ...(typeof cwd === "string" ? { cwd } : {}),
          ...(Object.keys(processEnv).length > 0 ? { env: processEnv } : {}),
        };
      }
    } else if (payload.targetKind === "native_app" && isPlainRecord(payload.targetPayload)) {
      const { appId, args, cwd, env, launchMode } = payload.targetPayload;
      if (typeof appId === "string") {
        const appArgs = Array.isArray(args) && args.every((arg) => typeof arg === "string") ? [...args] : [];
        const appLaunchMode = launchMode === "attach_or_launch" ? "attach_or_launch" : "new_instance";
        const directNativeEnv = DIRECT_NATIVE_PANE_EXECUTABLE_ENV.get(appId);
        const processEnv = {
          ...(directNativeEnv ?? {}),
          ...(isPlainRecord(env) && isStringRecord(env) ? env : {}),
        };
        paneEntry.target = "native_app";
        paneEntry.nativeApp = {
          appId,
          args: appArgs,
          launchMode: appLaunchMode,
        };
        paneEntry.process = {
          args: appArgs,
          command: appId,
          ...(typeof cwd === "string" ? { cwd } : {}),
          ...(Object.keys(processEnv).length > 0 ? { env: processEnv } : {}),
        };
      }
    }
    const overlayRect = {
      height: compositorViewport.height,
      width: compositorViewport.width,
      x: compositorViewport.x,
      y: compositorViewport.y,
    };
    return {
      op: "native_pane.host",
      overlaySet: {
        coordinateSpace: "surface_logical",
        regions: [{
          captures: ["pointer_hover", "pointer_button", "pointer_axis"],
          kind: "native_pane",
          paneId: String(lineagePane.paneId),
          paneInstanceId: lineagePane.paneLineageId,
          rect: overlayRect,
          regionId: `${lineagePane.paneId}:${payload.targetId}`,
          zIndex: Math.max(0, flattenLayout(surface.layout).indexOf(lineagePane.paneId)),
        }],
        revision: payload.targetEpoch as Revision,
        surfaceId: surface.surfaceId as SurfaceId,
        topologyEpoch: surface.topologyRevision as TopologyRevision,
        windowId: surface.windowLabel,
      },
      panes: [paneEntry],
    };
  }

  projectCurrentNativePaneGeometry(surfaceId: string, paneIds: number[]): NativePaneMaterialization {
    const surface = this.getSurface(surfaceId);
    return this.projectNativePaneGeometryUpdateFromSnapshots(surface, paneIds);
  }


  validateNativePaneMaterializationLayout(
    surfaceId: string,
    materialization: NativePaneMaterialization,
  ): string | null {
    const surface = this.getSurface(surfaceId);
    const paneGeometry = resolvePaneGeometrySnapshots(surface);
    for (const pane of materialization.panes) {
      const paneId = Number(pane.id);
      if (!Number.isInteger(paneId)) {
        return `native pane ${pane.id} does not map to a Surf Ace pane`;
      }
      const expected = paneGeometry.get(paneId)?.contentViewport;
      const expectedSnapshot = paneGeometry.get(paneId);
      if (!expected || !expectedSnapshot || expectedSnapshot.geometryUnavailable) {
        return `native pane ${pane.id} is not present in the resolved Surf Ace layout`;
      }
      if (
        pane.geometry.coordinateSpace !== "compositor_logical" ||
        pane.geometry.paneInstanceId !== expectedSnapshot.paneInstanceId ||
        pane.geometry.topologyEpoch !== expectedSnapshot.topologyEpoch ||
        pane.geometry.surfaceEpoch !== expectedSnapshot.surfaceEpoch ||
        pane.geometry.geometryRevision !== expectedSnapshot.geometryRevision
      ) {
        return `native pane ${pane.id} geometry identity does not match resolved Surf Ace pane geometry`;
      }
      const expectedCompositorRect = compositorResolvedRect(expected);
      if (!sameRect(pane.geometry, expectedCompositorRect)) {
        return `native pane ${pane.id} geometry ${formatRect(pane.geometry)} does not match resolved Surf Ace pane geometry ${formatRect(expectedCompositorRect)}`;
      }
    }
    return null;
  }

  markNativePaneMaterialized(
    surfaceId: string,
    materialization: NativePaneMaterialization,
  ): void {
    const surface = this.getSurface(surfaceId);
    let didChange = false;
    for (const materializedPane of materialization.panes) {
      const paneId = Number(materializedPane.id);
      const pane = Number.isInteger(paneId) ? surface.panes.get(paneId) : undefined;
      if (!pane) {
        continue;
      }
      didChange = replaceVisibleEntryForNativeMaterialization(pane, this.now()) || didChange;
      pane.nativeHost = {
        ...(materializedPane.binding_id ? { bindingId: materializedPane.binding_id } : {}),
        ...(materializedPane.content_id ? { contentId: materializedPane.content_id } : {}),
        ...(materializedPane.windowGroup?.launchIdentity.launchToken ? { launchToken: materializedPane.windowGroup.launchIdentity.launchToken } : {}),
        revision: materializedPane.revision,
      };
      pane.nativeWindowGroup = null;
      if (!pane.externalNative) {
        pane.externalNative = true;
        didChange = true;
      }
    }
    if (didChange) {
      this.emit({ surfaceId, type: "surface-changed" });
    }
  }

  markNativePaneWindowGroups(surfaceId: string, groups: NativePaneWindowGroupStatus[]): void {
    const surface = this.getSurface(surfaceId);
    const paneGeometry = resolvePaneGeometrySnapshots(surface);
    let didChange = false;
    const trustedGroups = new Map<number, NativePaneWindowGroupStatus>();
    for (const group of groups) {
      const paneId = Number(group.paneId);
      const pane = Number.isInteger(paneId) ? surface.panes.get(paneId) : undefined;
      if (!pane || !pane.nativeHost?.launchToken || !sameNativePaneWindowGroupIdentity(group, pane, paneGeometry.get(paneId))) {
        continue;
      }
      trustedGroups.set(paneId, group);
    }
    for (const [paneId, pane] of surface.panes) {
      if (!pane.externalNative || !pane.nativeHost?.launchToken) {
        continue;
      }
      const geometry = paneGeometry.get(paneId);
      if (!geometry || geometry.geometryUnavailable) {
        continue;
      }
      const trustedGroup = trustedGroups.get(paneId);
      const nextDiagnostic = trustedGroup
        ? nativePaneWindowGroupDiagnosticFromStatus(pane, geometry, trustedGroup)
        : null;
      if (!sameNativePaneWindowGroupDiagnostic(pane.nativeWindowGroup, nextDiagnostic)) {
        pane.nativeWindowGroup = nextDiagnostic;
        didChange = true;
      }
    }
    if (didChange) {
      this.emit({ surfaceId, type: "surface-changed" });
    }
  }

  private projectNativePaneGeometryUpdateFromSnapshots(
    surface: SurfaceState,
    paneIds: number[],
  ): NativePaneMaterialization {
    const resolvedGeometry = resolvePaneGeometrySnapshots(surface);
    const layoutOrder = flattenLayout(surface.layout);
    const panes = paneIds.map((paneId) => {
      const pane = surface.panes.get(paneId);
      if (!pane) {
        throw new SurfaceCoreError("invalid_payload", `Unknown pane: ${paneId}`);
      }
      if (!pane.externalNative) {
        throw new SurfaceCoreError("invalid_operation", `Pane ${paneId} is not native-hosted`);
      }
      const geometry = resolvedGeometry.get(pane.paneId);
      if (!geometry || geometry.geometryUnavailable) {
        throw new SurfaceCoreError("invalid_payload", `native pane ${pane.paneId} has no resolved Surf Ace geometry snapshot`);
      }
      const compositorViewport = compositorResolvedRect(geometry.contentViewport);
      return {
        ...(pane.nativeHost?.bindingId ? { binding_id: pane.nativeHost.bindingId } : {}),
        ...(pane.nativeHost?.contentId ? { content_id: pane.nativeHost.contentId } : {}),
        geometry: {
          coordinateSpace: "compositor_logical" as const,
          geometryRevision: geometry.geometryRevision,
          height: compositorViewport.height,
          paneInstanceId: geometry.paneInstanceId,
          surfaceEpoch: geometry.surfaceEpoch,
          topologyEpoch: geometry.topologyEpoch,
          width: compositorViewport.width,
          x: compositorViewport.x,
          y: compositorViewport.y,
        },
        id: String(pane.paneId),
        revision: pane.nativeHost?.revision ?? geometry.geometryRevision,
        ...(pane.nativeHost?.launchToken
          ? {
              windowGroup: {
                launchIdentity: {
                  launchToken: pane.nativeHost.launchToken,
                  paneId: String(pane.paneId),
                  paneInstanceId: pane.paneLineageId,
                  surfaceId: surface.surfaceId as SurfaceId,
                  ...(pane.nativeHost.contentId ? { targetId: pane.nativeHost.contentId } : {}),
                },
                policy: nativePaneWindowGroupPolicy(),
              },
            }
          : {}),
      };
    });
    return nativePaneMaterializationFromProjectedPanes(surface, panes, layoutOrder, {
      geometryRevision: surface.geometryRevision,
      topologyRevision: surface.topologyRevision,
      windowLabel: surface.windowLabel,
    });
  }

  nativeHostedPaneIdForLineage(surfaceId: string, paneLineageId: string): number | null {
    const surface = this.getSurface(surfaceId);
    const pane = paneForLineage(surface, paneLineageId);
    return pane?.externalNative ? pane.paneId : null;
  }

  nativeHostedPaneIdForPaneId(surfaceId: string, paneId: number): number | null {
    const pane = this.getSurface(surfaceId).panes.get(Number(paneId));
    return pane?.externalNative ? pane.paneId : null;
  }

  nativeHostedPaneIdsExcluding(surfaceId: string, retainedPaneIds: Iterable<number>): number[] {
    const retained = new Set([...retainedPaneIds].map((paneId) => Number(paneId)));
    return [...this.getSurface(surfaceId).panes.values()]
      .filter((pane) => pane.externalNative && !retained.has(pane.paneId))
      .map((pane) => pane.paneId);
  }

  nativeHostedPaneIdsForTopologyApply(surfaceId: string, payload: TopologyApplyRequest["payload"]): number[] {
    const surface = this.getSurface(surfaceId);
    assertSingleSurfacePaneLabelPayload(payload.panes);
    const retainedPaneIds = new Set(payload.panes.map((pane) => Number(pane.paneId)));
    return [...surface.panes.values()]
      .filter((pane) => pane.externalNative)
      .filter((pane) => !retainedPaneIds.has(pane.paneId))
      .map((pane) => pane.paneId);
  }

  nativeHostedPaneIdsForPaneSplit(
    surfaceId: string,
    payload: { count: number; newPaneIds: number[]; newPaneLabels: number[]; paneId: number },
  ): number[] {
    const surface = this.getSurface(surfaceId);
    const sourcePane = this.expectPane(surfaceId, payload.paneId);
    if (
      payload.count < 2 ||
      payload.newPaneIds.length !== payload.count - 1 ||
      payload.newPaneLabels.length !== payload.count - 1
    ) {
      throw new SurfaceCoreError("invalid_payload", "pane.split count/newPaneIds/newPaneLabels mismatch");
    }
    const newPaneIds = payload.newPaneIds.map((paneId) => Math.trunc(paneId));
    const newPaneLabels = payload.newPaneLabels.map((paneLabel) => Math.trunc(paneLabel));
    assertSingleSurfacePaneLabelPayload([
      ...[...surface.panes.values()].map((pane) => ({ paneLabel: pane.paneLabel })),
      ...newPaneLabels.map((paneLabel) => ({ paneLabel })),
    ]);
    for (const paneId of newPaneIds) {
      if (surface.panes.has(paneId)) {
        throw new SurfaceCoreError("invalid_payload", `Pane already exists: ${paneId}`);
      }
    }
    return [];
  }

  nativeHostedPaneIdsForPaneSplitGeometryUpdate(
    surfaceId: string,
    payload: { count: number; newPaneIds: number[]; newPaneLabels: number[]; paneId: number },
  ): number[] {
    const sourcePane = this.expectPane(surfaceId, payload.paneId);
    this.nativeHostedPaneIdsForPaneSplit(surfaceId, payload);
    return sourcePane.externalNative ? [sourcePane.paneId] : [];
  }

  nativeHostedPaneIdForPaneClose(surfaceId: string, paneId: number): number | null {
    const surface = this.getSurface(surfaceId);
    if (surface.panes.size <= 1) {
      throw new SurfaceCoreError("invalid_operation", "Cannot close the last pane");
    }
    const pane = surface.panes.get(paneId);
    if (!pane) {
      throw new SurfaceCoreError("invalid_payload", `Unknown pane: ${paneId}`);
    }
    return pane.externalNative ? pane.paneId : null;
  }

  nativeHostedPaneIdForContentApply(surfaceId: string, payload: ContentApplyRequest["payload"]): number | null {
    const pane = this.expectPane(surfaceId, payload.paneId);
    const current = currentEntry(pane);
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      throw new SurfaceCoreError(
        "invalid_operation",
        "clear" in payload && payload.clear
          ? "Cannot clear content while annotating"
          : "Cannot replace content while annotating",
      );
    }
    if ("clear" in payload && payload.clear) {
      assertRevision(pane, payload.revision);
      return pane.externalNative ? pane.paneId : null;
    }
    assertRevision(pane, payload.revision);
    return pane.externalNative ? pane.paneId : null;
  }

  nativeHostedPaneIdForContentSet(surfaceId: string, payload: ContentSetRequest["payload"]): number | null {
    const pane = this.expectPane(surfaceId, payload.paneId);
    if (!SUPPORTED_CONTENT_TYPES.includes(payload.contentType)) {
      throw new SurfaceCoreError(
        "unsupported_content_type",
        `Unsupported content type: ${payload.contentType}`,
      );
    }
    assertRevision(pane, payload.revision);
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      throw new SurfaceCoreError("invalid_operation", "Cannot replace content while annotating");
    }
    return pane.externalNative ? pane.paneId : null;
  }

  nativeHostedPaneIdForContentClear(surfaceId: string, payload: ContentClearRequest["payload"]): number | null {
    const pane = this.expectPane(surfaceId, payload.paneId);
    assertRevision(pane, payload.revision);
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      throw new SurfaceCoreError("invalid_operation", "Cannot clear content while annotating");
    }
    return pane.externalNative ? pane.paneId : null;
  }

  markNativePaneReleased(surfaceId: string, paneIds: Array<number | string>): void {
    const surface = this.getSurface(surfaceId);
    let didChange = false;
    for (const candidate of paneIds) {
      const paneId = Number(candidate);
      const pane = Number.isInteger(paneId) ? surface.panes.get(paneId) : undefined;
      if (!pane?.externalNative) {
        continue;
      }
      pane.externalNative = false;
      pane.nativeHost = null;
      pane.nativeWindowGroup = null;
      didChange = true;
    }
    if (didChange) {
      this.emit({ surfaceId, type: "surface-changed" });
    }
  }

  pairState(surfaceId: string): PairResponse["payload"]["state"] {
    const surface = this.getSurface(surfaceId);
    return {
      layout: surfaceLayoutToTopologyLayout(collapseLayout(surface.layout)),
      panes: surface.paneOrder.map((paneId) => {
        const pane = surface.panes.get(paneId)!;
        const current = currentEntry(pane);
        const currentTarget = currentTargetStateForEntry(pane, current);
        return {
          contentType: protocolContentType(current),
          currentContentId: protocolContentId(current),
          currentRevision: current.revision as Revision,
          ...(currentTarget ? { currentTarget } : {}),
          paneId: pane.paneId as PaneId,
          paneLabel: pane.paneLabel,
          paneLineageId: pane.paneLineageId,
        };
      }),
      topologyRevision: surface.topologyRevision as TopologyRevision,
    };
  }

  topologyState(surfaceId: string): TopologyApplyRequest["payload"] {
    const surface = this.getSurface(surfaceId);
    return {
      layout: surfaceLayoutToTopologyLayout(collapseLayout(surface.layout)),
      panes: surface.paneOrder.map((paneId) => {
        const pane = surface.panes.get(paneId)!;
        return {
          name: pane.name,
          paneId: pane.paneId as PaneId,
          paneLabel: pane.paneLabel,
        };
      }),
      topologyRevision: surface.topologyRevision as TopologyRevision,
      windowLabel: surface.windowLabel,
    };
  }

  applyWindowLabelOnly(surfaceId: string, windowLabel: string): void {
    assertValidWindowLabel(windowLabel);
    this.assertWindowLabelAvailable(surfaceId, windowLabel);
    const surface = this.getSurface(surfaceId);
    if (surface.windowLabel !== windowLabel) {
      if ([...surface.panes.values()].some((pane) => pane.externalNative)) {
        bumpGeometryRevision(surface);
      }
      surface.windowLabel = windowLabel;
      this.emit({ surfaceId, type: "surface-changed" });
    }
  }

  adoptProviderAuthorityPaneIdentities(surfaceId: string, providerPanes: AuthorityPaneIdentity[]): boolean {
    const surface = this.getSurface(surfaceId);
    if (providerPanes.length !== surface.panes.size) {
      return false;
    }

    const seenPaneIds = new Set<number>();
    const seenPaneLabels = new Set<number>();
    const updates: Array<{ pane: PaneState; paneLabel: number; paneLineageId: string }> = [];
    for (const candidate of providerPanes) {
      const paneId = Number(candidate.paneId);
      const paneLabel = Number(candidate.paneLabel);
      const paneLineageId = candidate.paneLineageId;
      const pane = Number.isInteger(paneId) ? surface.panes.get(paneId) : undefined;
      if (
        !pane ||
        seenPaneIds.has(paneId) ||
        !Number.isInteger(paneLabel) ||
        paneLabel < 1 ||
        seenPaneLabels.has(paneLabel) ||
        typeof paneLineageId !== "string" ||
        paneLineageId.length === 0
      ) {
        return false;
      }
      seenPaneIds.add(paneId);
      seenPaneLabels.add(paneLabel);
      updates.push({ pane, paneLabel, paneLineageId });
    }

    let didChange = false;
    for (const update of updates) {
      if (update.pane.paneLabel !== update.paneLabel) {
        update.pane.paneLabel = update.paneLabel;
        didChange = true;
      }
      if (update.pane.paneLineageId !== update.paneLineageId) {
        update.pane.paneLineageId = update.paneLineageId;
        didChange = true;
      }
    }
    if (didChange) {
      if ([...surface.panes.values()].some((pane) => pane.externalNative)) {
        bumpGeometryRevision(surface);
      }
      this.emit({ surfaceId, type: "surface-changed" });
    }
    return true;
  }

  assertProviderWindowLabelAvailable(surfaceId: string, windowLabel: string): void {
    assertValidWindowLabel(windowLabel);
    this.assertWindowLabelAvailable(surfaceId, windowLabel);
  }

  applyProviderBootstrapTopology(
    surfaceId: string,
    payload: { initialPaneId: number; initialPaneLabel: number; windowLabel: string },
  ): void {
    assertValidWindowLabel(payload.windowLabel);
    this.assertWindowLabelAvailable(surfaceId, payload.windowLabel);
    const surface = this.getSurface(surfaceId);
    let didChange = false;

    if (surface.windowLabel !== payload.windowLabel) {
      surface.windowLabel = payload.windowLabel;
      didChange = true;
    }

    if (this.ensureInitialPane(surface, payload.initialPaneId, payload.initialPaneLabel)) {
      bumpGeometryRevision(surface);
      didChange = true;
    }

    if (didChange) {
      this.emit({ surfaceId, type: "surface-changed" });
    }
  }

  resetProviderBootstrapTopology(
    surfaceId: string,
    payload: { initialPaneId: number; initialPaneLabel: number; windowLabel: string },
  ): void {
    assertValidWindowLabel(payload.windowLabel);
    this.assertWindowLabelAvailable(surfaceId, payload.windowLabel);
    if (payload.initialPaneId < 1 || payload.initialPaneLabel < 1) {
      return;
    }
    const surface = this.getSurface(surfaceId);
    const currentPaneId = surface.paneOrder[0];
    const currentPane = currentPaneId === undefined ? null : surface.panes.get(currentPaneId) ?? null;
    const canBootstrapReplace =
      surface.panes.size === 1 &&
      surface.layout?.type === "pane" &&
      currentPane !== null &&
      isPristineProviderBootstrapPane(currentPane);
    surface.windowLabel = payload.windowLabel;
    if (canBootstrapReplace) {
      if (this.ensureInitialPane(surface, payload.initialPaneId, payload.initialPaneLabel)) {
        bumpGeometryRevision(surface);
      }
      this.emit({ surfaceId, type: "surface-changed" });
      return;
    }
    const pane = createPaneState(payload.initialPaneId, payload.initialPaneLabel, this.now());
    surface.panes = new Map([[payload.initialPaneId, pane]]);
    surface.paneOrder = [payload.initialPaneId];
    surface.layout = { paneId: payload.initialPaneId, type: "pane" };
    surface.activeKeyboardPaneId = payload.initialPaneId;
    surface.topologyRevision += 1;
    bumpGeometryRevision(surface);
    this.emit({ surfaceId, type: "surface-changed" });
  }

  topologyApply(
    surfaceId: string,
    payload: TopologyApplyRequest["payload"],
  ): TopologyApplyResponse["payload"] {
    const surface = this.getSurface(surfaceId);
    assertValidWindowLabel(payload.windowLabel);
    this.assertWindowLabelAvailable(surfaceId, payload.windowLabel);
    assertSingleSurfacePaneLabelPayload(payload.panes);
    const paneStateById = new Map<number, TopologyApplyRequest["payload"]["panes"][number]>();
    for (const pane of payload.panes) {
      paneStateById.set(Number(pane.paneId), pane);
    }

    const layout = topologyLayoutToSurfaceLayout(payload.layout, paneStateById);
    const activePaneIds = flattenLayout(layout);
    const existingPanes = new Map(surface.panes);
    const nextPanes = new Map<number, PaneState>();
    const orderedPanes: number[] = [];

    for (const paneId of activePaneIds) {
      const summary = paneStateById.get(paneId)!;
      const existingPane = existingPanes.get(paneId);
      const pane = existingPane ?? createPaneState(paneId, summary.paneLabel, this.now());
      pane.paneLabel = summary.paneLabel;
      pane.name = summary.name;
      nextPanes.set(paneId, pane);
      orderedPanes.push(paneId);
    }

    surface.layout = layout;
    surface.windowLabel = payload.windowLabel;
    surface.paneOrder = orderedPanes;
    surface.panes = nextPanes;
    surface.topologyRevision = Number(payload.topologyRevision);
    bumpGeometryRevision(surface);
    this.ensureActiveKeyboardPane(surface);
    this.emit({ surfaceId, type: "surface-changed" });
    for (const paneId of activePaneIds) {
      if (existingPanes.has(paneId)) continue;
      const pane = nextPanes.get(paneId)!;
      this.emit({
        fromSplit: false,
        paneId,
        paneLabel: pane.paneLabel,
        parentPaneId: null,
        surfaceId,
        type: "pane-created",
      });
    }
    for (const paneId of existingPanes.keys()) {
      if (nextPanes.has(paneId)) continue;
      this.emit({ paneId, surfaceId, type: "pane-removed" });
    }

    return {
      panes: orderedPanes.map((paneId) => {
        const pane = nextPanes.get(paneId)!;
        return {
          name: pane.name,
          paneId: pane.paneId as PaneId,
          paneLabel: pane.paneLabel,
          paneLineageId: pane.paneLineageId,
        };
      }),
      topologyRevision: payload.topologyRevision,
    };
  }

  private assertWindowLabelAvailable(surfaceId: string, windowLabel: string): void {
    for (const [otherSurfaceId, surface] of this.surfaces) {
      if (otherSurfaceId === surfaceId) {
        continue;
      }
      if (surface.windowLabel === windowLabel) {
        throw new SurfaceCoreError("invalid_payload", `Duplicate windowLabel in live surface set: ${windowLabel}`);
      }
    }
  }

  contentApply(
    surfaceId: string,
    payload: ContentApplyRequest["payload"],
  ): ContentApplyResponse["payload"] {
    const surface = this.getSurface(surfaceId);
    if (payload.topologyRevision !== undefined) {
      surface.topologyRevision = Number(payload.topologyRevision);
    }
    if ("clear" in payload && payload.clear) {
      const pane = this.expectPane(surfaceId, payload.paneId);
      const current = currentEntry(pane);
      if (pane.annotating) {
        pane.toast = "Finish annotation (Done) to navigate";
        this.emit({ surfaceId, type: "surface-changed" });
        throw new SurfaceCoreError("invalid_operation", "Cannot clear content while annotating");
      }
      assertRevision(pane, payload.revision);
      if (pane.historyIndex < pane.history.length - 1) {
        pane.history = pane.history.slice(0, pane.historyIndex + 1);
      }
      pane.history.push({
        annotations: [],
        content: null,
        contentId: null,
        contentType: null,
        ownerToken: null,
        revision: payload.revision,
      });
      pane.historyIndex = pane.history.length - 1;
      trimHistory(pane);
      pane.toast = null;
      pane.externalNative = false;
      pane.nativeHost = null;
      pane.nativeWindowGroup = null;
      pane.latestContentEventAt = this.now();
      clearDirtyState(pane);
      this.emit({ surfaceId, type: "surface-changed" });
      return {
        ...currentMutationAck(pane),
        topologyRevision: payload.topologyRevision,
      };
    }

    const pane = this.expectPane(surfaceId, payload.paneId);
    const current = currentEntry(pane);
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      throw new SurfaceCoreError("invalid_operation", "Cannot replace content while annotating");
    }
    assertRevision(pane, payload.revision);

    if (pane.historyIndex < pane.history.length - 1) {
      pane.history = pane.history.slice(0, pane.historyIndex + 1);
    }
    const nextEntry: HistoryEntry = {
      annotations: payload.restoredDrawings ? structuredClone(payload.restoredDrawings) : [],
      content: cloneContent(payload.content),
      contentId: payload.contentId,
      contentType: payload.contentType,
      display: payload.display ? { ...payload.display } : undefined,
      ownerToken: payload.historyOwnerToken,
      reloadSource: cloneReloadSource(payload.reloadSource) ?? undefined,
      revision: payload.revision,
    };
    if (shouldReplaceVisibleEntry(pane, payload.historyOwnerToken)) {
      pane.history[pane.historyIndex] = nextEntry;
    } else {
      pane.history.push(nextEntry);
      pane.historyIndex = pane.history.length - 1;
    }
    trimHistory(pane);
    pane.toast = null;
    pane.externalNative = false;
    pane.nativeHost = null;
    pane.nativeWindowGroup = null;
    pane.latestContentEventAt = this.now();
    clearDirtyState(pane);
    this.emit({ surfaceId, type: "surface-changed" });
    return {
      ...currentMutationAck(pane),
      topologyRevision: payload.topologyRevision,
    };
  }

  targetApply(
    surfaceId: string,
    payload: TargetApplyRequest["payload"],
  ): TargetApplyResponse["payload"] {
    const validation = this.validateBrowserUrlTarget(surfaceId, payload);
    if ("result" in validation) {
      return validation.result;
    }
    const { pane, url } = validation;
    if (pane.externalNative) {
      return targetApplyResult(payload, "rejected", "materialization_failed", "browser_url cannot replace a live native-hosted pane without native pane detach support");
    }

    if (pane.historyIndex < pane.history.length - 1) {
      pane.history = pane.history.slice(0, pane.historyIndex + 1);
    }
    pane.history.push({
      annotations: [],
      content: { url: url.toString() },
      contentId: payload.targetId,
      contentType: "browser_url",
      display: payload.display ? { ...payload.display } : undefined,
      ownerToken: null,
      revision: payload.targetEpoch,
    });
    pane.historyIndex = pane.history.length - 1;
    trimHistory(pane);
    pane.toast = null;
    pane.externalNative = false;
    pane.nativeHost = null;
    pane.nativeWindowGroup = null;
    pane.latestContentEventAt = this.now();
    clearDirtyState(pane);
    this.emit({ surfaceId, type: "surface-changed" });
    return targetApplyResult(payload, "failed", "materialization_failed", "browser_url navigation started but has not been verified by the renderer", {
      navigationStatus: "started_unverified",
      replaySemantics: "navigate",
      url: url.toString(),
    });
  }

  registerLocklessTarget(
    surfaceId: string,
    paneId: number,
    payload: {
      idempotencyKey: string;
      launchedAt: string;
      registrationState: "before_attach" | "attached";
      restorePolicy?: string;
      targetHeader: Record<string, unknown>;
      targetKind: string;
      targetPayload: unknown;
    },
  ): PaneCurrentTargetState {
    const pane = this.expectPane(surfaceId, paneId);
    const entry = currentEntry(pane);
    if (entry.registeredTarget?.idempotencyKey === payload.idempotencyKey) {
      return structuredClone(entry.registeredTarget);
    }
    const previous = currentTargetStateForEntry(pane, entry);
    const target: NonNullable<HistoryEntry["registeredTarget"]> = {
      currentState: "current",
      idempotencyKey: payload.idempotencyKey,
      launchedAt: payload.launchedAt,
      paneLineageId: pane.paneLineageId,
      registrationState: payload.registrationState,
      restorePolicy: locklessTargetRestorePolicy(
        payload.restorePolicy,
        payload.targetKind,
        payload.targetHeader,
      ),
      targetEpoch: (previous?.targetEpoch ?? 0) + 1,
      targetHeader: structuredClone(payload.targetHeader) as never,
      targetId: `tg_${randomBytes(8).toString("hex")}`,
      targetKind: payload.targetKind as PaneCurrentTargetState["targetKind"],
      targetPayload: structuredClone(payload.targetPayload),
    };
    entry.registeredTarget = target;
    this.emit({ surfaceId, type: "surface-changed" });
    return structuredClone(target);
  }

  locklessTargetRegistration(
    surfaceId: string,
    paneId: number,
    idempotencyKey: string,
  ): PaneCurrentTargetState | null {
    const target = currentEntry(
      this.expectPane(surfaceId, paneId),
    ).registeredTarget;
    return target?.idempotencyKey === idempotencyKey
      ? structuredClone(target)
      : null;
  }

  browserUrlTargetPreflight(
    surfaceId: string,
    payload: TargetApplyRequest["payload"],
  ): TargetApplyResponse["payload"] | null {
    const validation = this.validateBrowserUrlTarget(surfaceId, payload);
    return "result" in validation ? validation.result : null;
  }

  private validateBrowserUrlTarget(
    surfaceId: string,
    payload: TargetApplyRequest["payload"],
  ): BrowserUrlTargetValidation {
    const surface = this.getSurface(surfaceId);
    if (payload.surfaceId !== surface.surfaceId) {
      return { result: targetApplyResult(payload, "rejected", "materialization_failed", "target.apply surfaceId does not match this surface") };
    }
    if (!payload.targetHeader.requiredCapabilities.every((capability) =>
      (SUPPORTED_TARGET_CAPABILITIES as readonly string[]).includes(capability)
    )) {
      return { result: targetApplyResult(payload, "rejected", "capability_missing", "required target capability is not advertised") };
    }
    if (payload.targetKind !== "browser_url") {
      return { result: targetApplyResult(payload, "rejected", "unsupported_target_kind", `Unsupported target kind: ${payload.targetKind}`) };
    }
    if (payload.targetHeader.replaySemantics !== "navigate") {
      return { result: targetApplyResult(payload, "rejected", "unsafe_payload", "browser_url requires navigate replay semantics") };
    }
    const targetPayload = payload.targetPayload as Partial<BrowserUrlPayload>;
    if (typeof targetPayload.url !== "string" || targetPayload.url.trim() === "") {
      return { result: targetApplyResult(payload, "rejected", "unsafe_payload", "browser_url targetPayload.url is required") };
    }
    const url = parseSafeBrowserUrl(targetPayload.url);
    if (!url) {
      return { result: targetApplyResult(payload, "rejected", "unsafe_payload", "browser_url targetPayload.url must be http or https") };
    }
    const pane = paneForLineage(surface, payload.paneLineageId);
    if (!pane) {
      return { result: targetApplyResult(payload, "rejected", "pane_lineage_missing", "pane lineage is unknown") };
    }
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      return { result: targetApplyResult(payload, "rejected", "policy_denied", "annotation mode is active") };
    }
    return { pane, url };
  }

  completeBrowserUrlNavigation(
    surfaceId: string,
    paneId: number,
    evidence: { errorMessage?: string; status: "applied" | "failed"; targetId: string; url: string },
    applyResult?: TargetApplyResponse["payload"],
  ): TargetApplyResponse["payload"] | null {
    const pane = this.expectPane(surfaceId, paneId);
    const entry = currentEntry(pane);
    if (entry.contentType !== "browser_url" || entry.contentId !== evidence.targetId) {
      return null;
    }
    const payload = applyResult ?? targetApplyResult(
      {
        paneLineageId: pane.paneLineageId,
        requestId: "",
        targetEpoch: entry.revision,
        targetId: evidence.targetId,
      } as TargetApplyRequest["payload"],
      evidence.status,
      evidence.status === "failed" ? "materialization_failed" : undefined,
      evidence.status === "applied" ? "browser_url navigation loaded" : evidence.errorMessage ?? "browser_url navigation failed",
      {
        navigationStatus: evidence.status === "applied" ? "loaded" : "failed",
        replaySemantics: "navigate",
        url: evidence.url,
      },
    );
    entry.lastApplyEvidence = payload;
    this.emit({ surfaceId, type: "surface-changed" });
    return payload;
  }

  paneSplit(
    surfaceId: string,
    payload: { count: number; direction: "horizontal" | "vertical"; newPaneIds: number[]; newPaneLabels: number[]; paneId: number },
  ): { panes: PaneSplitState[] } {
    const surface = this.getSurface(surfaceId);
    const sourcePane = this.expectPane(surfaceId, payload.paneId);
    if (
      payload.count < 2 ||
      payload.newPaneIds.length !== payload.count - 1 ||
      payload.newPaneLabels.length !== payload.count - 1
    ) {
      throw new SurfaceCoreError("invalid_payload", "pane.split count/newPaneIds/newPaneLabels mismatch");
    }

    const newPaneIds = payload.newPaneIds.map((paneId) => Math.trunc(paneId));
    const newPaneLabels = payload.newPaneLabels.map((paneLabel) => Math.trunc(paneLabel));
    assertSingleSurfacePaneLabelPayload([
      ...[...surface.panes.values()].map((pane) => ({ paneLabel: pane.paneLabel })),
      ...newPaneLabels.map((paneLabel) => ({ paneLabel })),
    ]);
    for (const paneId of newPaneIds) {
      if (surface.panes.has(paneId)) {
        throw new SurfaceCoreError("invalid_payload", `Pane already exists: ${paneId}`);
      }
    }

    const newPanes = newPaneIds.map((paneId, index) => createPaneState(paneId, newPaneLabels[index]!, this.now()));
    for (const pane of newPanes) {
      surface.panes.set(pane.paneId, pane);
      surface.paneOrder.push(pane.paneId);
    }
    surface.activeKeyboardPaneId = sourcePane.paneId;
    surface.layout = splitLayoutNode(surface.layout!, sourcePane.paneId, payload.direction, [
      sourcePane.paneId,
      ...newPaneIds,
    ]);
    const knownPaneIds = new Set(surface.panes.keys());
    if (flattenLayout(surface.layout).some((paneId) => !knownPaneIds.has(paneId))) {
      const sanitizedLayout = sanitizeLayoutNode(surface.layout, knownPaneIds);
      if (sanitizedLayout) {
        surface.layout = collapseLayout(sanitizedLayout);
      }
    }

    surface.topologyRevision = Math.max(1, surface.topologyRevision + 1);
    bumpGeometryRevision(surface);

    this.emit({ surfaceId, type: "surface-changed" });
    for (const paneId of newPaneIds) {
      this.emit({
        fromSplit: true,
        paneId,
        paneLabel: newPanes.find((pane) => pane.paneId === paneId)!.paneLabel,
        parentPaneId: payload.paneId,
        surfaceId,
        type: "pane-created",
      });
    }

    return {
      panes: flattenLayout(surface.layout!).map((paneId) => ({
        paneId,
        paneLabel: surface.panes.get(paneId)!.paneLabel,
      })),
    };
  }

  paneRename(surfaceId: string, paneId: number, name: string | null): { name: string | null; paneId: number } {
    const pane = this.expectPane(surfaceId, paneId);
    pane.name = name;
    this.emit({ surfaceId, type: "surface-changed" });
    this.emit({ name, paneId, surfaceId, type: "pane-renamed" });
    return { name, paneId };
  }

  locklessPaneRename(
    surfaceId: string,
    paneId: number,
    name: string | null,
  ): { name: string | null; paneId: number; topologyRevision: number } {
    const result = this.paneRename(surfaceId, paneId, name);
    const surface = this.getSurface(surfaceId);
    surface.topologyRevision = Math.max(1, surface.topologyRevision + 1);
    bumpGeometryRevision(surface);
    this.emit({ surfaceId, type: "topology-changed" });
    return { ...result, topologyRevision: surface.topologyRevision };
  }

  resizeSplit(surfaceId: string, path: number[], weights: number[]): void {
    const surface = this.getSurface(surfaceId);
    if (!surface.layout) {
      throw new SurfaceCoreError("invalid_payload", "Cannot resize a surface without layout");
    }
    surface.layout = updateSplitWeights(surface.layout, path, weights);
    surface.topologyRevision = Math.max(1, surface.topologyRevision + 1);
    bumpGeometryRevision(surface);
    this.emit({ surfaceId, type: "surface-changed" });
    this.emit({ surfaceId, type: "topology-changed" });
  }

  paneClose(surfaceId: string, paneId: number): PaneCloseResponse["payload"] {
    const surface = this.getSurface(surfaceId);
    if (surface.panes.size <= 1) {
      throw new SurfaceCoreError("invalid_operation", "Cannot close the last pane");
    }
    const pane = surface.panes.get(paneId);
    if (!pane) {
      throw new SurfaceCoreError("invalid_payload", `Unknown pane: ${paneId}`);
    }
    const closedFramesDiscarded = pane.deliveredClosedFrameCount;

    surface.panes.delete(paneId);
    surface.paneOrder = surface.paneOrder.filter((entry) => entry !== paneId);
    surface.layout = collapseLayout(removePaneFromLayout(surface.layout!, paneId));
    surface.topologyRevision = Math.max(1, surface.topologyRevision + 1);
    bumpGeometryRevision(surface);
    this.ensureActiveKeyboardPane(surface);
    this.emit({ surfaceId, type: "surface-changed" });
    this.emit({ paneId, surfaceId, type: "pane-removed" });
    return {
      closedFramesDiscarded,
      paneId: paneId as PaneId,
    };
  }

  contentSet(
    surfaceId: string,
    payload: ContentSetRequest["payload"],
  ): MutationAckResponse["payload"] {
    const surface = this.getSurface(surfaceId);
    const pane = this.expectPane(surfaceId, payload.paneId);
    if (!SUPPORTED_CONTENT_TYPES.includes(payload.contentType)) {
      throw new SurfaceCoreError(
        "unsupported_content_type",
        `Unsupported content type: ${payload.contentType}`,
      );
    }
    assertRevision(pane, payload.revision);
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      throw new SurfaceCoreError("invalid_operation", "Cannot replace content while annotating");
    }

    if (pane.historyIndex < pane.history.length - 1) {
      pane.history = pane.history.slice(0, pane.historyIndex + 1);
    }

    const nextEntry: HistoryEntry = {
      annotations: [],
      content: cloneContent(payload.content),
      contentId: payload.contentId,
      contentType: payload.contentType,
      display: payload.display ? { ...payload.display } : undefined,
      ownerToken: payload.historyOwnerToken,
      reloadSource: cloneReloadSource(payload.reloadSource) ?? undefined,
      revision: payload.revision,
    };
    if (shouldReplaceVisibleEntry(pane, payload.historyOwnerToken)) {
      pane.history[pane.historyIndex] = nextEntry;
    } else {
      pane.history.push(nextEntry);
      pane.historyIndex = pane.history.length - 1;
    }
    trimHistory(pane);
    pane.toast = null;
    pane.externalNative = false;
    pane.nativeHost = null;
    pane.nativeWindowGroup = null;
    pane.latestContentEventAt = this.now();
    clearDirtyState(pane);
    bumpGeometryRevision(surface);
    this.emit({ surfaceId, type: "surface-changed" });

    return currentMutationAck(pane);
  }

  locklessContentPush(
    surfaceId: string,
    payload: LocklessContentPush,
    controllerProductName: string | null,
  ): LocklessContentCommit {
    const surface = this.getSurface(surfaceId);
    const pane = this.expectPane(surfaceId, payload.paneId);
    if (!SUPPORTED_CONTENT_TYPES.includes(payload.contentType as ContentType)) {
      throw new SurfaceCoreError(
        "unsupported_content_type",
        `Unsupported content type: ${payload.contentType}`,
      );
    }
    if (pane.annotating) {
      throw new SurfaceCoreError(
        "invalid_operation",
        "Cannot replace content while annotating",
      );
    }
    const historyEntryId = `he_${randomUUID().replaceAll("-", "")}`;
    const revision = Math.max(
      pane.nextRevision,
      Math.max(0, ...pane.history.map((entry) => entry.revision)) + 1,
    );
    pane.nextRevision = revision + 1;
    if (pane.historyIndex < pane.history.length - 1) {
      pane.history = pane.history.slice(0, pane.historyIndex + 1);
    }
    const friendlyChatName = payload.friendlyChatName?.trim() || null;
    const productName = controllerProductName?.trim() || null;
    const visibleSequence =
      Math.max(0, ...pane.history.map((entry) => entry.lastVisibleSequence ?? 0)) +
      1;
    pane.history.push({
      annotations: [],
      content: cloneContent(payload.content as ContentPayload),
      contentId: payload.contentId,
      contentType: payload.contentType as ContentType,
      display: {
        ...(payload.display as ContentDisplay | undefined),
        senderDisplayName: `${friendlyChatName ?? "Unknown chat"} — ${productName ?? "Unknown provider"}`,
      },
      historyEntryId,
      lastVisibleSequence: visibleSequence,
      ownerToken: null,
      provenance: {
        controllerProductName: productName,
        friendlyChatName,
      },
      revision,
    });
    pane.historyIndex = pane.history.length - 1;
    while (pane.history.length > MAX_HISTORY_DEPTH + 1) {
      const victim = pane.history
        .map((entry, index) => ({ entry, index }))
        .filter(({ index }) => index !== pane.historyIndex)
        .sort(
          (left, right) =>
            (left.entry.lastVisibleSequence ?? 0) -
            (right.entry.lastVisibleSequence ?? 0),
        )[0];
      if (!victim) break;
      pane.history.splice(victim.index, 1);
      if (victim.index < pane.historyIndex) pane.historyIndex -= 1;
    }
    pane.toast = null;
    pane.externalNative = false;
    pane.nativeHost = null;
    pane.nativeWindowGroup = null;
    pane.latestContentEventAt = this.now();
    clearDirtyState(pane);
    bumpGeometryRevision(surface);
    this.emit({ surfaceId, type: "surface-changed" });
    return {
      contentId: payload.contentId,
      historyEntryId,
      paneId: payload.paneId,
      revision,
    };
  }

  capturePaneTombstonePayload(
    surfaceId: string,
    paneId: number,
  ): { pane: PersistentPaneRecord; paneOrderIndex: number } {
    const record = serializeSurface(this.getSurface(surfaceId));
    const pane = record.panes.find((candidate) => candidate.paneId === paneId);
    if (!pane) {
      throw new SurfaceCoreError("invalid_payload", `Unknown pane: ${paneId}`);
    }
    return {
      pane: structuredClone(pane),
      paneOrderIndex: record.paneOrder.indexOf(paneId),
    };
  }

  restorePaneTombstone(
    surfaceId: string,
    tombstonePayload: { pane: PersistentPaneRecord; paneOrderIndex: number },
    anchorPaneId: number,
    direction: "horizontal" | "vertical",
  ): { paneId: number; paneLabel: number; topologyRevision: number } {
    const surface = this.getSurface(surfaceId);
    this.expectPane(surfaceId, anchorPaneId);
    let payload = structuredClone(tombstonePayload);
    if (surface.panes.has(payload.pane.paneId)) {
      throw new SurfaceCoreError(
        "invalid_operation",
        `Pane is already live: ${payload.pane.paneId}`,
      );
    }
    if (
      [...surface.panes.values()].some(
        (pane) => pane.paneLabel === payload.pane.paneLabel,
      )
    ) {
      const usedLabels = new Set(
        [...surface.panes.values()].map((pane) => pane.paneLabel),
      );
      let nextLabel = 1;
      while (usedLabels.has(nextLabel)) nextLabel += 1;
      payload.pane.paneLabel = nextLabel;
    }
    const serialized = serializeSurface(surface);
    const restoredSurface = deserializeSurface(
      {
        ...serialized,
        activeKeyboardPaneId: payload.pane.paneId,
        layout: { paneId: payload.pane.paneId, type: "pane" },
        paneOrder: [payload.pane.paneId],
        panes: [payload.pane],
      },
      this.now(),
    );
    const pane = restoredSurface?.panes.get(payload.pane.paneId);
    if (!pane) {
      throw new SurfaceCoreError(
        "invalid_payload",
        "Pane tombstone payload is invalid",
      );
    }
    surface.panes.set(pane.paneId, pane);
    const insertionIndex = Math.min(
      Math.max(0, payload.paneOrderIndex),
      surface.paneOrder.length,
    );
    surface.paneOrder.splice(insertionIndex, 0, pane.paneId);
    surface.layout = splitLayoutNode(
      surface.layout!,
      anchorPaneId,
      direction,
      [anchorPaneId, pane.paneId],
    );
    surface.topologyRevision = Math.max(1, surface.topologyRevision + 1);
    bumpGeometryRevision(surface);
    this.emit({ surfaceId, type: "surface-changed" });
    this.emit({
      fromSplit: false,
      paneId: pane.paneId,
      paneLabel: pane.paneLabel,
      parentPaneId: anchorPaneId,
      surfaceId,
      type: "pane-created",
    });
    this.emit({ surfaceId, type: "topology-changed" });
    return {
      paneId: pane.paneId,
      paneLabel: pane.paneLabel,
      topologyRevision: surface.topologyRevision,
    };
  }

  contentClear(surfaceId: string, payload: ContentClearRequest["payload"]): MutationAckResponse["payload"] {
    const surface = this.getSurface(surfaceId);
    const pane = this.expectPane(surfaceId, payload.paneId);
    assertRevision(pane, payload.revision);
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      throw new SurfaceCoreError("invalid_operation", "Cannot clear content while annotating");
    }

    if (pane.historyIndex < pane.history.length - 1) {
      pane.history = pane.history.slice(0, pane.historyIndex + 1);
    }

    pane.history.push({
      annotations: [],
      content: null,
      contentId: null,
      contentType: null,
      ownerToken: null,
      revision: payload.revision,
    });
    pane.historyIndex = pane.history.length - 1;
    trimHistory(pane);
    pane.toast = null;
    pane.externalNative = false;
    pane.nativeHost = null;
    pane.nativeWindowGroup = null;
    pane.latestContentEventAt = this.now();
    clearDirtyState(pane);
    bumpGeometryRevision(surface);
    this.emit({ surfaceId, type: "surface-changed" });
    return currentMutationAck(pane);
  }

  reloadSource(surfaceId: string, paneId: number): ContentReloadSource | null {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane || pane.externalNative || pane.annotating) {
      return null;
    }
    return cloneReloadSource(currentEntry(pane).reloadSource);
  }

  replaceCurrentContentFromReloadSource(
    surfaceId: string,
    paneId: number,
    content: ContentPayload,
    expected?: ReloadEntryIdentity,
  ): void {
    const surface = this.getSurface(surfaceId);
    const pane = this.expectPane(surfaceId, paneId);
    const entry = currentEntry(pane);
    if (!entry.reloadSource || !entry.contentType || entry.contentType === "browser_url" || pane.externalNative) {
      return;
    }
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      return;
    }
    if (
      expected &&
      (entry.contentId !== expected.contentId ||
        entry.contentType !== expected.contentType ||
        pane.latestContentEventAt !== expected.renderVersion ||
        entry.revision !== expected.revision ||
        entry.reloadSource.kind !== expected.reloadSource.kind ||
        entry.reloadSource.path !== expected.reloadSource.path)
    ) {
      return;
    }
    entry.content = cloneContent(content);
    pane.toast = null;
    pane.latestContentEventAt = this.now();
    bumpGeometryRevision(surface);
    this.emit({ surfaceId, type: "surface-changed" });
  }

  contentAppend(surfaceId: string, payload: ContentAppendRequest["payload"]): MutationAckResponse["payload"] {
    const pane = this.expectPane(surfaceId, payload.paneId);
    const entry = currentEntry(pane);
    assertRevision(pane, payload.revision);
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      throw new SurfaceCoreError("invalid_operation", "Cannot append content while annotating");
    }
    if (entry.contentId !== payload.contentId) {
      throw new SurfaceCoreError("stale_content", "content.append targeted stale content");
    }
    if (entry.contentType !== "terminal" || !entry.content || typeof entry.content !== "object" || !("lines" in entry.content)) {
      throw new SurfaceCoreError(
        "unsupported_operation_for_content_type",
        "content.append only supports terminal content",
      );
    }

    entry.content = {
      ...entry.content,
      lines: [...entry.content.lines, ...payload.lines],
    };
    entry.revision = payload.revision;
    pane.toast = null;
    pane.latestContentEventAt = this.now();
    this.emit({ surfaceId, type: "surface-changed" });
    return currentMutationAck(pane);
  }

  contentPatch(surfaceId: string, payload: ContentPatchRequest["payload"]): MutationAckResponse["payload"] {
    const pane = this.expectPane(surfaceId, payload.paneId);
    const entry = currentEntry(pane);
    assertRevision(pane, payload.revision);
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      throw new SurfaceCoreError("invalid_operation", "Cannot patch content while annotating");
    }
    if (entry.contentId !== payload.contentId) {
      throw new SurfaceCoreError("stale_content", "content.patch targeted stale content");
    }
    if (entry.contentType !== "html" || !entry.content || typeof entry.content !== "object" || !("html" in entry.content)) {
      throw new SurfaceCoreError(
        "unsupported_operation_for_content_type",
        "content.patch only supports html content",
      );
    }

    entry.content = {
      ...entry.content,
      html: patchHtml(entry.content.html, payload.patch),
    };
    entry.revision = payload.revision;
    pane.latestContentEventAt = this.now();
    this.emit({ surfaceId, type: "surface-changed" });
    return currentMutationAck(pane);
  }

  annotationsRemove(
    surfaceId: string,
    payload: { contentId: string; paneId: number; strokeIds: string[] },
  ): {
    contentId: string;
    notFoundStrokeIds: string[];
    paneId: number;
    remainingStrokeCount: number;
    removedStrokeIds: string[];
  } {
    const pane = this.expectPane(surfaceId, payload.paneId);
    const entry = currentEntry(pane);
    if (!entry.contentId || entry.contentId !== payload.contentId) {
      throw new SurfaceCoreError("stale_content", "annotations.remove targeted stale content");
    }

    const toRemove = new Set(payload.strokeIds);
    const removedStrokeIds: string[] = [];
    const notFoundStrokeIds: string[] = [];
    const before = new Set(entry.annotations.map((stroke) => stroke.strokeId));
    for (const strokeId of payload.strokeIds) {
      if (before.has(strokeId as StrokeId)) {
        removedStrokeIds.push(strokeId);
      } else {
        notFoundStrokeIds.push(strokeId);
      }
    }

    entry.annotations = entry.annotations.filter((stroke) => !toRemove.has(stroke.strokeId));
    pane.dirtyStrokeIds = pane.dirtyStrokeIds.filter((strokeId) => !toRemove.has(strokeId));
    this.emit({ surfaceId, type: "surface-changed" });

    return {
      contentId: entry.contentId,
      notFoundStrokeIds,
      paneId: pane.paneId,
      remainingStrokeCount: entry.annotations.length,
      removedStrokeIds,
    };
  }

  updatePaneSnapshot(
    surfaceId: string,
    paneId: number,
    snapshot: Partial<PaneSnapshot>,
  ): void {
    const surface = this.getSurface(surfaceId);
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return;
    }
    const previousBounds = pane.snapshot.bounds;
    const previousIdentity = paneSnapshotIdentity(pane.snapshot);
    const reportedIdentity = snapshotGeometryIdentity(snapshot);
    const acceptsBounds = snapshot.bounds === undefined || (
      reportedIdentity !== null && sameGeometryIdentity(
        reportedIdentity,
        this.resolvedPaneGeometryIdentity(surfaceId),
      )
    );
    pane.snapshot = {
      bounds: acceptsBounds && snapshot.bounds !== undefined ? snapshot.bounds : pane.snapshot.bounds,
      geometryRevision: acceptsBounds && snapshot.bounds !== undefined
        ? reportedIdentity!.geometryRevision
        : pane.snapshot.geometryRevision,
      selection: snapshot.selection ?? pane.snapshot.selection,
      surfaceEpoch: acceptsBounds && snapshot.bounds !== undefined
        ? reportedIdentity!.surfaceEpoch
        : pane.snapshot.surfaceEpoch,
      topologyRevision: acceptsBounds && snapshot.bounds !== undefined
        ? reportedIdentity!.topologyRevision
        : pane.snapshot.topologyRevision,
      viewport: snapshot.viewport ?? pane.snapshot.viewport,
      visibleText: snapshot.visibleText ?? pane.snapshot.visibleText,
    };
    const nextBounds = pane.snapshot.bounds;
    const nextIdentity = paneSnapshotIdentity(pane.snapshot);
    if (
      acceptsBounds &&
      nextBounds &&
      (!previousBounds || !sameRect(previousBounds, nextBounds) || !sameOptionalGeometryIdentity(previousIdentity, nextIdentity))
    ) {
      this.emit({ paneIds: [pane.paneId], surfaceId, type: "pane-geometry-changed" });
    }
  }

  captureSnapshot(surfaceId: string, paneId: number): SnapshotResponse["payload"] {
    const pane = this.expectPane(surfaceId, paneId);
    const current = currentEntry(pane);
    return {
      contentId: protocolContentId(current),
      contentType: protocolContentType(current),
      paneId: pane.paneId as PaneId,
      revision: current.revision as Revision,
      selection: pane.snapshot.selection,
      viewport: structuredClone(pane.snapshot.viewport),
      visibleText: snapshotVisibleText(pane, current),
    };
  }

  paneBounds(surfaceId: string, paneId: number): { height: number; width: number; x: number; y: number } | null {
    const pane = this.requirePane(surfaceId, paneId);
    return pane?.snapshot.bounds ?? null;
  }

  noteTap(surfaceId: string, paneId: number): void {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return;
    }
    pane.toast = null;
  }

  applyNavigation(surfaceId: string, paneId: number, url: string): {
    blocked: boolean;
    contentId?: string;
    revision?: number;
    url?: string;
  } {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return { blocked: false };
    }
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      return { blocked: true };
    }
    const current = currentEntry(pane);
    if (current.contentType !== "html" || !current.contentId) {
      pane.toast = null;
      this.emit({ surfaceId, type: "surface-changed" });
      return { blocked: false };
    }
    const normalizedUrl = parseSafeBrowserUrl(url);
    if (!normalizedUrl) {
      pane.toast = "Cannot navigate to unsupported URL";
      this.emit({ surfaceId, type: "surface-changed" });
      return { blocked: true };
    }
    if (pane.historyIndex < pane.history.length - 1) {
      pane.history = pane.history.slice(0, pane.historyIndex + 1);
    }
    pane.history.push({
      annotations: [],
      content: { url: normalizedUrl.toString() },
      contentId: current.contentId,
      contentType: "browser_url",
      display: current.display ? { ...current.display } : undefined,
      ownerToken: null,
      revision: current.revision,
    });
    pane.historyIndex = pane.history.length - 1;
    trimHistory(pane);
    pane.toast = null;
    pane.externalNative = false;
    pane.nativeHost = null;
    pane.nativeWindowGroup = null;
    pane.latestContentEventAt = this.now();
    clearDirtyState(pane);
    this.emit({ surfaceId, type: "surface-changed" });
    return {
      blocked: false,
      contentId: current.contentId,
      revision: current.revision,
      url: normalizedUrl.toString(),
    };
  }

  addStroke(
    surfaceId: string,
    paneId: number,
    stroke: Stroke,
  ): { contentId: string; revision: number } {
    const pane = this.expectPane(surfaceId, paneId);
    if (!pane.annotating) {
      throw new SurfaceCoreError("invalid_operation", "Annotation mode is not active");
    }
    const entry = currentEntry(pane);
    if (!entry.contentId) {
      throw new SurfaceCoreError("invalid_operation", "No active content for annotation");
    }

    entry.annotations = [...entry.annotations, structuredClone(stroke)];
    pane.annotationFrameOpen = true;
    pane.dirtyStrokeIds.push(stroke.strokeId);
    pane.firstDirtyStrokeAt ??= firstPointTimestamp(stroke);
    pane.lastDirtyStrokeAt = lastPointTimestamp(stroke);
    pane.toast = null;
    this.emit({ surfaceId, type: "surface-changed" });
    this.emit({ paneId, surfaceId, type: "drawing-dirty" });
    return { contentId: entry.contentId, revision: entry.revision };
  }

  hasPendingDrawingFlush(surfaceId: string, paneId: number): boolean {
    const pane = this.requirePane(surfaceId, paneId);
    return pane ? pane.dirtyStrokeIds.length > 0 : false;
  }

  flushMeta(surfaceId: string, paneId: number): {
    firstDirtyStrokeAt: number | null;
    flushInFlight: boolean;
    lastDirtyStrokeAt: number | null;
    lastSuccessfulFlushAt: number | null;
  } {
    const pane = this.requirePane(surfaceId, paneId);
    return {
      firstDirtyStrokeAt: pane?.firstDirtyStrokeAt ?? null,
      flushInFlight: pane?.flushInFlight ?? false,
      lastDirtyStrokeAt: pane?.lastDirtyStrokeAt ?? null,
      lastSuccessfulFlushAt: pane?.lastSuccessfulFlushAt ?? null,
    };
  }

  setFlushInFlight(surfaceId: string, paneId: number, visible: boolean): void {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return;
    }
    if (pane.flushInFlight === visible) {
      return;
    }
    pane.flushInFlight = visible;
    this.emit({ surfaceId, type: "surface-changed" });
  }

  buildDrawingFlush(
    surfaceId: string,
    paneId: number,
    config: DrawingFlushConfig,
    flushReason: DrawingFlushEvent["payload"]["flushReason"],
  ): DrawingFlushEvent["payload"] | null {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return null;
    }
    const entry = currentEntry(pane);
    if (!entry.contentId || pane.dirtyStrokeIds.length === 0) {
      return null;
    }

    const dirtySet = new Set(pane.dirtyStrokeIds);
    const dirtyStrokes = entry.annotations.filter((stroke) => dirtySet.has(stroke.strokeId));
    if (dirtyStrokes.length === 0) {
      return null;
    }

    return {
      contentId: entry.contentId,
      firstStrokeAt: (pane.firstDirtyStrokeAt ?? this.now()) as EpochMs,
      flushId: `fl_${randomBytes(6).toString("hex")}`,
      flushReason,
      idleWindowMs: config.idleWindowMs,
      lastStrokeAt: (pane.lastDirtyStrokeAt ?? this.now()) as EpochMs,
      maxIntervalMs: config.maxIntervalMs,
      paneId: pane.paneId as PaneId,
      pointsCount: dirtyStrokes.reduce((total, stroke) => total + stroke.points.length, 0),
      revision: entry.revision as Revision,
      strokeCount: dirtyStrokes.length,
      strokes: structuredClone(dirtyStrokes),
    };
  }

  markDrawingFlushSent(surfaceId: string, paneId: number): void {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return;
    }
    pane.dirtyStrokeIds = [];
    pane.deliveredClosedFrameCount += 1;
    pane.firstDirtyStrokeAt = null;
    pane.lastDirtyStrokeAt = null;
    pane.lastSuccessfulFlushAt = this.now();
    pane.flushInFlight = false;
    this.emit({ surfaceId, type: "surface-changed" });
  }

  hasPendingAnnotationCommit(surfaceId: string, paneId: number): boolean {
    const pane = this.requirePane(surfaceId, paneId);
    return pane?.pendingAnnotationCommit ?? false;
  }

  buildAnnotationCommitted(
    surfaceId: string,
    paneId: number,
  ): AnnotationCommittedEvent["payload"] | null {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane || !pane.pendingAnnotationCommit || pane.flushInFlight || pane.dirtyStrokeIds.length > 0) {
      return null;
    }
    const entry = currentEntry(pane);
    if (!entry.contentId) {
      return null;
    }
    return {
      committedAt: this.now() as EpochMs,
      contentId: entry.contentId,
      paneId: pane.paneId as PaneId,
      revision: entry.revision as Revision,
    };
  }

  markAnnotationCommittedSent(surfaceId: string, paneId: number): void {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return;
    }
    pane.pendingAnnotationCommit = false;
    pane.annotationFrameOpen = false;
  }

  surfaceName(surfaceId: string): string {
    return this.getSurface(surfaceId).name;
  }

  viewport(surfaceId: string): SurfaceViewport {
    return cloneViewport(this.getSurface(surfaceId).viewport);
  }

  setViewport(surfaceId: string, viewport: SurfaceViewport): void {
    const surface = this.getSurface(surfaceId);
    if (
      surface.viewport.width === viewport.width &&
      surface.viewport.height === viewport.height &&
      surface.viewport.scale === viewport.scale
    ) {
      return;
    }
    surface.viewport = cloneViewport(viewport);
    bumpGeometryRevision(surface, { rotateSurfaceEpoch: true });
    this.emit({ surfaceId, type: "surface-changed" });
  }

  surfaceWindowLabel(surfaceId: string): string {
    return this.getSurface(surfaceId).windowLabel;
  }

  activePaneIds(surfaceId: string): number[] {
    return [...this.getSurface(surfaceId).paneOrder];
  }

  supportsContentType(contentType: ContentType): boolean {
    return SUPPORTED_CONTENT_TYPES.includes(contentType);
  }

  capabilities() {
    return {
      contentTypes: [...SUPPORTED_CONTENT_TYPES],
      eventTypes: [
        "event.drawing_flush",
        "event.history_navigated",
        "event.tap",
        "event.selection",
        "event.page",
        "event.navigation",
        "event.annotation_committed",
        "event.snapshot_hint",
        "event.scroll",
        "event.surface_appeared",
        "event.surface_removed",
        "event.surface_resumed",
        "event.pane_created",
        "event.pane_removed",
        "event.pane_renamed",
      ],
      targetCapabilities: [...SUPPORTED_TARGET_CAPABILITIES],
    };
  }

  private createSurface(surfaceId: string, name: string, viewport: SurfaceViewport): SurfaceState {
    const bootstrapPane = createPaneState(BOOTSTRAP_PANE_ID, 0, this.now());
    const surface: SurfaceState = {
      activeKeyboardPaneId: BOOTSTRAP_PANE_ID,
      connectionBar: "disconnected",
      geometryRevision: 1,
      layout: { paneId: BOOTSTRAP_PANE_ID, type: "pane" },
      name,
      paneOrder: [BOOTSTRAP_PANE_ID],
      panes: new Map([[BOOTSTRAP_PANE_ID, bootstrapPane]]),
      providerOwnership: null,
      providerName: null,
      surfaceId,
      surfaceEpoch: `${surfaceId}:1`,
      surfaceEpochRevision: 1,
      topologyRevision: 0,
      viewport: cloneViewport(viewport),
      windowPlacement: null,
      windowLabel: "",
    };
    this.surfaces.set(surfaceId, surface);
    this.emit({ surfaceId, type: "surface-created" });
    this.emit({ surfaceId, type: "surface-changed" });
    return surface;
  }

  private ensureInitialPane(surface: SurfaceState, initialPaneId: number, initialPaneLabel: number): boolean {
    if (initialPaneId < 1 || surface.panes.size !== 1) {
      return false;
    }
    const currentPaneId = surface.paneOrder[0];
    if (currentPaneId === undefined) {
      return false;
    }
    const currentPane = surface.panes.get(currentPaneId);
    if (!currentPane || currentEntry(currentPane).contentId !== null || currentPane.history.length !== 1) {
      return false;
    }
    if (surface.panes.has(initialPaneId) && currentPaneId !== initialPaneId) {
      return false;
    }
    if (currentPaneId === initialPaneId) {
      if (currentPane.paneLabel === initialPaneLabel) {
        return false;
      }
      currentPane.paneLabel = initialPaneLabel;
      return true;
    }

    const replacementPane = createPaneState(initialPaneId, initialPaneLabel, this.now());
    replacementPane.annotating = currentPane.annotating;
    replacementPane.annotationFrameOpen = currentPane.annotationFrameOpen;
    replacementPane.deliveredClosedFrameCount = currentPane.deliveredClosedFrameCount;
    replacementPane.dirtyStrokeIds = [...currentPane.dirtyStrokeIds];
    replacementPane.firstDirtyStrokeAt = currentPane.firstDirtyStrokeAt;
    replacementPane.flushInFlight = currentPane.flushInFlight;
    replacementPane.lastDirtyStrokeAt = currentPane.lastDirtyStrokeAt;
    replacementPane.lastSuccessfulFlushAt = currentPane.lastSuccessfulFlushAt;
    replacementPane.latestContentEventAt = currentPane.latestContentEventAt;
    replacementPane.name = currentPane.name;
    replacementPane.pendingAnnotationCommit = currentPane.pendingAnnotationCommit;
    replacementPane.snapshot = structuredClone(currentPane.snapshot);
    replacementPane.toast = currentPane.toast;

    surface.panes.delete(currentPaneId);
    surface.panes.set(initialPaneId, replacementPane);
    surface.paneOrder = [initialPaneId];
    surface.layout = { paneId: initialPaneId, type: "pane" };
    surface.activeKeyboardPaneId = initialPaneId;
    return true;
  }

  private findPane(surfaceId: string, paneId: number): PaneState | null {
    return this.getSurface(surfaceId).panes.get(paneId) ?? null;
  }

  private requirePane(surfaceId: string, paneId: number): PaneState | null {
    const pane = this.findPane(surfaceId, paneId);
    if (!pane) {
      this.logger.warn?.(
        `[surf-ace:surface] ignoring unknown pane ${paneId} on ${surfaceId}`,
      );
      return null;
    }
    return pane;
  }

  private expectPane(surfaceId: string, paneId: number): PaneState {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      throw new SurfaceCoreError("invalid_payload", `Unknown pane: ${paneId}`);
    }
    return pane;
  }

  private emit(event: CoreEvent): void {
    if (this.pendingEvents) {
      this.pendingEvents.push(structuredClone(event));
      return;
    }
    this.deliver(event);
  }

  private deliver(event: CoreEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private ensureActiveKeyboardPane(surface: SurfaceState): void {
    if (surface.activeKeyboardPaneId !== null && surface.panes.has(surface.activeKeyboardPaneId)) {
      return;
    }
    surface.activeKeyboardPaneId = surface.paneOrder[0] ?? null;
  }
}

type PaneSplitState = {
  paneId: number;
  paneLabel: number;
};

function createPaneState(paneId: number, paneLabel: number, now: number): PaneState {
  return {
    annotating: false,
    annotationFrameOpen: false,
    deliveredClosedFrameCount: 0,
    dirtyStrokeIds: [],
    firstDirtyStrokeAt: null,
    externalNative: false,
    flushInFlight: false,
    history: [
      {
        annotations: [],
        content: null,
        contentId: null,
        contentType: null,
        ownerToken: null,
        revision: 0,
      },
    ],
    historyIndex: 0,
    lastDirtyStrokeAt: null,
    lastSuccessfulFlushAt: now,
    latestContentEventAt: now,
    name: null,
    nextRevision: 1,
    nativeHost: null,
    nativeWindowGroup: null,
    paneId,
    paneLabel,
    paneLineageId: `pl_${randomUUID().replaceAll("-", "")}`,
    pendingAnnotationCommit: false,
    snapshot: {
      bounds: null,
      geometryRevision: null,
      selection: null,
      surfaceEpoch: null,
      topologyRevision: null,
      viewport: {
        contentSize: { height: DEFAULT_VISIBLE_RECT.height, width: DEFAULT_VISIBLE_RECT.width },
        scrollOffset: { x: 0, y: 0 },
        visibleRect: { ...DEFAULT_VISIBLE_RECT },
        zoomLevel: 1,
      },
      visibleText: "",
    },
    toast: null,
  };
}

function serializeSurface(surface: SurfaceState): PersistentSurfaceRecord {
  return {
    activeKeyboardPaneId: surface.activeKeyboardPaneId,
    geometryRevision: surface.geometryRevision,
    layout: surface.layout ? structuredClone(surface.layout) : null,
    name: surface.name,
    paneOrder: [...surface.paneOrder],
    panes: surface.paneOrder
      .map((paneId) => surface.panes.get(paneId))
      .filter((pane): pane is PaneState => Boolean(pane))
      .map((pane) => ({
        annotating: pane.annotating,
        annotationFrameOpen: pane.annotationFrameOpen,
        deliveredClosedFrameCount: pane.deliveredClosedFrameCount,
        dirtyStrokeIds: [...pane.dirtyStrokeIds],
        externalNative: false,
        firstDirtyStrokeAt: pane.firstDirtyStrokeAt,
        flushInFlight: false,
        history: pane.history.map(persistedHistoryEntry),
        historyIndex: pane.historyIndex,
        lastDirtyStrokeAt: pane.lastDirtyStrokeAt,
        lastSuccessfulFlushAt: pane.lastSuccessfulFlushAt,
        latestContentEventAt: pane.latestContentEventAt,
        name: pane.name,
        nextRevision: pane.nextRevision,
        paneId: pane.paneId,
        paneLabel: pane.paneLabel,
        paneLineageId: pane.paneLineageId,
        pendingAnnotationCommit: pane.pendingAnnotationCommit,
        snapshot: structuredClone(pane.snapshot),
        toast: pane.toast,
      })),
    providerOwnership: surface.providerOwnership ? structuredClone(surface.providerOwnership) : null,
    surfaceEpochRevision: surface.surfaceEpochRevision,
    surfaceId: surface.surfaceId,
    topologyRevision: surface.topologyRevision,
    viewport: cloneViewport(surface.viewport),
    windowPlacement: cloneWindowPlacement(surface.windowPlacement),
    windowLabel: surface.windowLabel,
  };
}

function deserializeSurface(record: PersistentSurfaceRecord, now: number): SurfaceState | null {
  if (!Array.isArray(record.panes) || record.panes.length === 0) {
    return null;
  }
  const panes = new Map<number, PaneState>();
  const paneOrder: number[] = [];
  for (const paneRecord of record.panes) {
    if (!Number.isInteger(paneRecord.paneId) || panes.has(paneRecord.paneId)) {
      return null;
    }
    if (!Array.isArray(paneRecord.history) || paneRecord.history.length === 0) {
      return null;
    }
    const pane = createPaneState(
      paneRecord.paneId,
      Number.isInteger(paneRecord.paneLabel) ? paneRecord.paneLabel : paneRecord.paneId,
      now,
    );
    pane.annotating = Boolean(paneRecord.annotating);
    pane.annotationFrameOpen = Boolean(paneRecord.annotationFrameOpen);
    pane.deliveredClosedFrameCount = Number(paneRecord.deliveredClosedFrameCount ?? 0);
    pane.dirtyStrokeIds = Array.isArray(paneRecord.dirtyStrokeIds) ? [...paneRecord.dirtyStrokeIds] : [];
    pane.externalNative = false;
    pane.firstDirtyStrokeAt = typeof paneRecord.firstDirtyStrokeAt === "number" ? paneRecord.firstDirtyStrokeAt : null;
    pane.flushInFlight = false;
    pane.history = structuredClone(paneRecord.history);
    pane.historyIndex = Math.min(
      Math.max(0, Math.trunc(Number(paneRecord.historyIndex ?? 0))),
      pane.history.length - 1,
    );
    pane.lastDirtyStrokeAt = typeof paneRecord.lastDirtyStrokeAt === "number" ? paneRecord.lastDirtyStrokeAt : null;
    pane.lastSuccessfulFlushAt = typeof paneRecord.lastSuccessfulFlushAt === "number" ? paneRecord.lastSuccessfulFlushAt : now;
    pane.latestContentEventAt = typeof paneRecord.latestContentEventAt === "number" ? paneRecord.latestContentEventAt : now;
    pane.name = typeof paneRecord.name === "string" ? paneRecord.name : null;
    pane.nextRevision =
      Number.isSafeInteger(paneRecord.nextRevision) &&
      Number(paneRecord.nextRevision) > 0
        ? Number(paneRecord.nextRevision)
        : Math.max(
            0,
            ...pane.history.map((entry) => entry.revision),
          ) + 1;
    pane.nativeHost = null;
    pane.nativeWindowGroup = null;
    pane.paneLineageId = typeof paneRecord.paneLineageId === "string" && paneRecord.paneLineageId.length > 0
      ? paneRecord.paneLineageId
      : pane.paneLineageId;
    pane.pendingAnnotationCommit = Boolean(paneRecord.pendingAnnotationCommit);
    pane.snapshot = paneRecord.snapshot
      ? {
          ...structuredClone(paneRecord.snapshot),
          geometryRevision: Number.isInteger(paneRecord.snapshot.geometryRevision)
            ? paneRecord.snapshot.geometryRevision
            : null,
          surfaceEpoch: typeof paneRecord.snapshot.surfaceEpoch === "string"
            ? paneRecord.snapshot.surfaceEpoch
            : null,
          topologyRevision: Number.isInteger(paneRecord.snapshot.topologyRevision)
            ? paneRecord.snapshot.topologyRevision
            : null,
        }
      : pane.snapshot;
    pane.toast = typeof paneRecord.toast === "string" ? paneRecord.toast : null;
    panes.set(pane.paneId, pane);
    paneOrder.push(pane.paneId);
  }
  if (panes.size === 0) {
    return null;
  }
  if (
    !Array.isArray(record.paneOrder) ||
    record.paneOrder.length === 0 ||
    record.paneOrder.some((paneId) => !panes.has(paneId))
  ) {
    return null;
  }
  const finalPaneOrder = record.paneOrder;
  const knownPaneIds = new Set(finalPaneOrder);
  if (record.layout && !layoutReferencesKnownPanes(record.layout, knownPaneIds)) {
    return null;
  }
  const sanitizedLayout = record.layout ? sanitizeLayoutNode(record.layout, knownPaneIds) : null;
  const layout = collapseLayout(sanitizedLayout ?? { paneId: finalPaneOrder[0]!, type: "pane" });
  const surfaceEpochRevision = Math.max(1, Math.trunc(Number(record.surfaceEpochRevision ?? 1)));
  return {
    activeKeyboardPaneId: panes.has(Number(record.activeKeyboardPaneId)) ? Number(record.activeKeyboardPaneId) : finalPaneOrder[0]!,
    connectionBar: "disconnected",
    geometryRevision: Math.max(1, Math.trunc(Number(record.geometryRevision ?? 1))),
    layout,
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : "Surf Ace",
    paneOrder: finalPaneOrder,
    panes,
    providerOwnership: deserializeProviderOwnership(record.providerOwnership),
    providerName: null,
    surfaceEpoch: `${record.surfaceId}:${surfaceEpochRevision}`,
    surfaceEpochRevision,
    surfaceId: record.surfaceId,
    topologyRevision: Math.max(0, Math.trunc(Number(record.topologyRevision ?? 0))),
    viewport: record.viewport ? cloneViewport(record.viewport) : {
      height: DEFAULT_VISIBLE_RECT.height,
      scale: 1,
      width: DEFAULT_VISIBLE_RECT.width,
    },
    windowPlacement: cloneWindowPlacement(record.windowPlacement),
    windowLabel: isValidWindowLabel(record.windowLabel) ? record.windowLabel : "",
  };
}

function deserializeProviderOwnership(input: unknown): PersistentProviderOwnership | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as Partial<PersistentProviderOwnership>;
  if (
    typeof record.providerId !== "string" ||
    record.providerId.length === 0 ||
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    !Number.isFinite(record.ownershipEpoch)
  ) {
    return null;
  }
  return {
    ownershipEpoch: Math.max(1, Math.trunc(Number(record.ownershipEpoch))),
    providerId: record.providerId,
    sessionId: record.sessionId,
  };
}

function assertSingleSurfacePaneLabelPayload(panes: Array<{ paneLabel: number }>): void {
  const usedPaneLabels = new Set<number>();
  for (const pane of panes) {
    if (!Number.isInteger(pane.paneLabel) || pane.paneLabel <= 0) {
      throw new SurfaceCoreError("invalid_payload", "paneLabel must be a positive integer");
    }
    if (usedPaneLabels.has(pane.paneLabel)) {
      throw new SurfaceCoreError("invalid_payload", `Duplicate paneLabel in surface payload: ${pane.paneLabel}`);
    }
    usedPaneLabels.add(pane.paneLabel);
  }
}

function currentEntry(pane: PaneState): HistoryEntry {
  return pane.history[pane.historyIndex]!;
}

function isPristineProviderBootstrapPane(
  pane: PaneState,
  allowResolvedGeometry = false,
): boolean {
  const entry = currentEntry(pane);
  return pane.history.length === 1 &&
    pane.historyIndex === 0 &&
    !pane.annotating &&
    !pane.annotationFrameOpen &&
    pane.dirtyStrokeIds.length === 0 &&
    !pane.externalNative &&
    !pane.flushInFlight &&
    pane.firstDirtyStrokeAt === null &&
    pane.lastDirtyStrokeAt === null &&
    pane.name === null &&
    pane.nativeHost === null &&
    !pane.pendingAnnotationCommit &&
    (allowResolvedGeometry || pane.snapshot.bounds === null) &&
    pane.snapshot.selection === null &&
    pane.snapshot.visibleText === "" &&
    pane.toast === null &&
    entry.annotations.length === 0 &&
    entry.content === null &&
    entry.contentId === null &&
    entry.contentType === null &&
    entry.ownerToken === null &&
    entry.revision === 0;
}

function paneForLineage(surface: SurfaceState, lineageId: string): PaneState | null {
  return [...surface.panes.values()].find((pane) => pane.paneLineageId === lineageId) ?? null;
}

function shouldReplaceVisibleEntry(pane: PaneState, ownerToken: string): boolean {
  const current = currentEntry(pane);
  if (current.contentId === null) {
    return true;
  }
  return current.ownerToken === ownerToken;
}

function assertRevision(pane: PaneState, revision: number): void {
  const expectedRevision = currentEntry(pane).revision + 1;
  if (revision !== expectedRevision) {
    throw new SurfaceCoreError("stale_revision", `Expected revision ${expectedRevision}`, {
      expectedRevision,
    });
  }
}

function trimHistory(pane: PaneState): void {
  if (pane.history.length <= MAX_HISTORY_DEPTH) {
    return;
  }
  const overflow = pane.history.length - MAX_HISTORY_DEPTH;
  pane.history.splice(0, overflow);
  pane.historyIndex = Math.max(0, pane.historyIndex - overflow);
}

function replaceVisibleEntryForNativeMaterialization(pane: PaneState, now: number): boolean {
  const current = currentEntry(pane);
  if (current.content === null && current.contentId === null && current.contentType === null) {
    return false;
  }
  if (pane.historyIndex < pane.history.length - 1) {
    pane.history = pane.history.slice(0, pane.historyIndex + 1);
  }
  pane.history.push({
    annotations: [],
    content: null,
    contentId: null,
    contentType: null,
    ownerToken: null,
    revision: current.revision,
  });
  pane.historyIndex = pane.history.length - 1;
  trimHistory(pane);
  pane.toast = null;
  pane.latestContentEventAt = now;
  clearDirtyState(pane);
  return true;
}

function clearDirtyState(pane: PaneState): void {
  pane.annotationFrameOpen = false;
  pane.dirtyStrokeIds = [];
  pane.firstDirtyStrokeAt = null;
  pane.lastDirtyStrokeAt = null;
  pane.flushInFlight = false;
  pane.pendingAnnotationCommit = false;
}

function cloneViewport(viewport: SurfaceViewport): SurfaceViewport {
  return { ...viewport };
}

function cloneContent(content: RenderablePayload | null): RenderablePayload | null {
  return content ? structuredClone(content) : null;
}

function cloneReloadSource(source: ContentReloadSource | undefined): ContentReloadSource | null {
  if (!source) {
    return null;
  }
  return { kind: source.kind, path: source.path };
}

function isReloadableEntry(entry: HistoryEntry, externalNative: boolean): boolean {
  if (externalNative) {
    return false;
  }
  return entry.contentType === "browser_url" || entry.reloadSource?.kind === "file";
}

function htmlVisibleText(content: HtmlContent): string | null {
  const { document } = parseHTML(content.html);
  const text = (document.body?.innerText ?? document.body?.textContent ?? "").trim();
  return text ? text.slice(0, 4096) : null;
}

function snapshotVisibleText(pane: PaneState, entry: HistoryEntry): string {
  const snapshotText = pane.snapshot.visibleText;
  if (
    entry.contentType !== "html" ||
    entry.content === null ||
    typeof entry.content !== "object" ||
    !("html" in entry.content)
  ) {
    return snapshotText;
  }
  if (snapshotText) {
    return snapshotText;
  }
  return htmlVisibleText(entry.content as HtmlContent) ?? snapshotText;
}

function currentMutationAck(pane: PaneState): MutationAckResponse["payload"] {
  const entry = currentEntry(pane);
  return {
    contentId: protocolContentId(entry),
    contentType: protocolContentType(entry),
    currentContentId: protocolContentId(entry),
    currentRevision: entry.revision as Revision,
    paneId: pane.paneId as PaneId,
  };
}

function protocolContentId(entry: HistoryEntry): ContentId | null {
  return entry.contentType === "browser_url" ? null : entry.contentId as ContentId | null;
}

function protocolContentType(entry: HistoryEntry): ContentType | null {
  return entry.contentType === "browser_url" ? null : entry.contentType as ContentType | null;
}

function currentTargetStateForEntry(pane: PaneState, entry: HistoryEntry): PaneCurrentTargetState | null {
  if (entry.registeredTarget) {
    return structuredClone(entry.registeredTarget);
  }
  if (entry.contentType !== "browser_url" || entry.contentId === null || entry.content === null || !("url" in entry.content)) {
    return null;
  }
  return {
    currentState: "current",
    paneLineageId: pane.paneLineageId,
    restorePolicy: "auto",
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: ["target.browser_url.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: entry.content.url,
    },
    targetEpoch: entry.revision,
    targetId: entry.contentId,
    targetKind: "browser_url",
    targetPayload: { url: entry.content.url },
    ...(entry.lastApplyEvidence ? { lastApplyEvidence: structuredClone(entry.lastApplyEvidence) } : {}),
  };
}

function locklessTargetRestorePolicy(
  requested: string | undefined,
  targetKind: string,
  targetHeader: Record<string, unknown>,
): PaneCurrentTargetState["restorePolicy"] {
  if (
    requested === "auto" ||
    requested === "confirm" ||
    requested === "manual" ||
    requested === "never"
  ) {
    return requested;
  }
  if (targetHeader.safetyClass === "privileged") return "manual";
  if (
    targetKind === "terminal_app" ||
    targetKind === "native_app" ||
    targetKind === "compositor_app"
  ) {
    return "confirm";
  }
  if (targetKind === "video") return "never";
  return "auto";
}

function parseSafeBrowserUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function targetApplyResult(
  payload: TargetApplyRequest["payload"],
  status: TargetApplyResponse["payload"]["status"],
  errorCode?: TargetApplyResponse["payload"]["errorCode"],
  message?: string,
  materializedState?: TargetMaterializedState,
): TargetApplyResponse["payload"] {
  return {
    appliedAt: new Date().toISOString(),
    errorCode,
    materializedState,
    message,
    paneLineageId: payload.paneLineageId,
    requestId: payload.requestId,
    status,
    targetEpoch: payload.targetEpoch,
    targetId: payload.targetId,
  };
}

function flattenLayout(node: LayoutNode): number[] {
  if (node.type === "pane") {
    return [node.paneId];
  }
  return node.children.flatMap(flattenLayout);
}

function topologyLayoutToSurfaceLayout(
  node: TopologyApplyRequest["payload"]["layout"],
  paneStateById: Map<number, TopologyApplyRequest["payload"]["panes"][number]>,
): LayoutNode {
  if (node.type === "pane") {
    const paneId = Number(node.paneId);
    if (!paneStateById.has(paneId)) {
      throw new SurfaceCoreError("invalid_payload", `topology.apply missing pane summary for ${paneId}`);
    }
    return {
      paneId,
      type: "pane",
      ...(typeof node.weight === "number" ? { weight: node.weight } : {}),
    };
  }

  return {
    children: node.children.map((child) => topologyLayoutToSurfaceLayout(child, paneStateById)),
    direction: node.direction,
    type: "split",
    ...(typeof node.weight === "number" ? { weight: node.weight } : {}),
  };
}

function surfaceLayoutToTopologyLayout(node: LayoutNode): TopologyApplyRequest["payload"]["layout"] {
  if (node.type === "pane") {
    return {
      paneId: node.paneId as PaneId,
      type: "pane",
      ...(node.weight !== undefined ? { weight: node.weight } : {}),
    };
  }
  return {
    children: node.children.map(surfaceLayoutToTopologyLayout),
    direction: node.direction,
    type: "split",
    ...(node.weight !== undefined ? { weight: node.weight } : {}),
  };
}

function splitLayoutNode(
  node: LayoutNode,
  targetPaneId: number,
  direction: "horizontal" | "vertical",
  paneIds: number[],
): LayoutNode {
  if (node.type === "pane") {
    if (node.paneId !== targetPaneId) {
      return node;
    }
    return {
      children: paneIds.map((paneId) => ({ paneId, type: "pane" })),
      direction,
      type: "split",
    };
  }
  return {
    ...node,
    children: node.children.map((child) =>
      splitLayoutNode(child, targetPaneId, direction, paneIds),
    ),
  };
}

function removePaneFromLayout(node: LayoutNode, paneId: number): LayoutNode | null {
  if (node.type === "pane") {
    return node.paneId === paneId ? null : node;
  }
  const nextChildren = node.children
    .map((child) => removePaneFromLayout(child, paneId))
    .filter((child): child is LayoutNode => child !== null);
  if (nextChildren.length === 0) {
    return null;
  }
  if (nextChildren.length === 1) {
    return nextChildren[0]!;
  }
  return {
    ...node,
    children: nextChildren,
  };
}

function updateSplitWeights(node: LayoutNode, path: number[], weights: number[]): LayoutNode {
  if (path.length === 0) {
    if (node.type !== "split" || weights.length !== node.children.length) {
      throw new SurfaceCoreError("invalid_payload", "resize-split path/weights do not match a split");
    }
    return {
      ...node,
      children: node.children.map((child, index) => ({
        ...child,
        weight: Math.max(0.05, Number(weights[index] ?? 1)),
      })),
    };
  }
  if (node.type !== "split") {
    throw new SurfaceCoreError("invalid_payload", "resize-split path does not resolve to a split");
  }
  const [nextIndex, ...rest] = path;
  if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= node.children.length) {
    throw new SurfaceCoreError("invalid_payload", "resize-split path index is invalid");
  }
  return {
    ...node,
    children: node.children.map((child, index) => index === nextIndex ? updateSplitWeights(child, rest, weights) : child),
  };
}

function sanitizeLayoutNode(node: LayoutNode, knownPaneIds: Set<number>): LayoutNode | null {
  if (node.type === "pane") {
    return knownPaneIds.has(node.paneId) ? node : null;
  }
  const nextChildren = node.children
    .map((child) => sanitizeLayoutNode(child, knownPaneIds))
    .filter((child): child is LayoutNode => child !== null);
  if (nextChildren.length === 0) {
    return null;
  }
  if (nextChildren.length === 1) {
    return nextChildren[0]!;
  }
  return {
    ...node,
    children: nextChildren,
  };
}

function layoutReferencesKnownPanes(node: LayoutNode, knownPaneIds: Set<number>): boolean {
  if (node.type === "pane") {
    return knownPaneIds.has(node.paneId);
  }
  return node.children.every((child) => layoutReferencesKnownPanes(child, knownPaneIds));
}

function collapseLayout(node: LayoutNode | null): LayoutNode {
  if (!node) {
    throw new SurfaceCoreError("internal_error", "Layout collapsed unexpectedly");
  }
  if (node.type === "pane") {
    return node;
  }
  if (node.children.length === 1) {
    return collapseLayout(node.children[0]!);
  }
  return {
    ...node,
    children: node.children.map(collapseLayout),
  };
}

function nativePaneMaterializationFromProjectedPanes(
  surface: SurfaceState,
  panes: NativePaneMaterialization["panes"],
  layoutOrder: number[],
  revision: { geometryRevision: number; topologyRevision: number; windowLabel: string },
): NativePaneMaterialization {
  return {
    op: "native_pane.update",
    overlaySet: {
      coordinateSpace: "surface_logical",
      regions: panes.map((pane) => ({
        captures: ["pointer_hover", "pointer_button", "pointer_axis"],
        kind: "native_pane",
        paneId: pane.id,
        paneInstanceId: pane.geometry.paneInstanceId,
        rect: {
          height: pane.geometry.height,
          width: pane.geometry.width,
          x: pane.geometry.x,
          y: pane.geometry.y,
        },
        regionId: `${pane.id}:${pane.content_id ?? pane.geometry.paneInstanceId}`,
        zIndex: Math.max(0, layoutOrder.indexOf(Number(pane.id))),
      })),
      revision: revision.geometryRevision as Revision,
      surfaceId: surface.surfaceId as SurfaceId,
      topologyEpoch: revision.topologyRevision as TopologyRevision,
      windowId: revision.windowLabel,
    },
    panes,
  };
}

function nativePaneWindowGroupDiagnosticFromStatus(
  pane: PaneState,
  geometry: PaneGeometryProjection,
  group: NativePaneWindowGroupStatus,
): NativePaneWindowGroupDiagnostic {
  return {
    acceptedSecondaryCount: group.acceptedSecondaryCount,
    clippingStatus: group.clippingStatus,
    deniedReasons: [...group.deniedReasons],
    deniedToplevelCount: group.deniedToplevelCount,
    focusedWindowId: group.focusedWindowId,
    launchToken: group.launchToken,
    members: group.members.map((member) => ({
      bounds: member.bounds ? structuredClone(member.bounds) : null,
      clippedToPane: member.clippedToPane,
      focused: member.focused,
      id: member.id,
      lifecycle: member.lifecycle,
      role: member.role,
    })),
    paneId: pane.paneId as PaneId,
    paneInstanceId: group.paneInstanceId ?? geometry.paneInstanceId,
    paneLocalBounds: group.paneLocalBounds ?? compositorResolvedRect(geometry.contentViewport),
    primaryWindowId: group.primaryWindowId,
  };
}

function sameNativePaneWindowGroupDiagnostic(
  a: NativePaneWindowGroupDiagnostic | null,
  b: NativePaneWindowGroupDiagnostic | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameNativePaneWindowGroupIdentity(
  group: NativePaneWindowGroupStatus,
  pane: PaneState,
  geometry: PaneGeometryProjection | undefined,
): boolean {
  if (pane.nativeHost?.launchToken) {
    return group.launchToken === pane.nativeHost.launchToken;
  }
  if (group.paneInstanceId && geometry && group.paneInstanceId === geometry.paneInstanceId) {
    return true;
  }
  const expectedPrimaryWindowIds = [
    pane.nativeHost?.bindingId,
    pane.nativeHost?.contentId,
    String(pane.paneId),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return group.primaryWindowId !== null && expectedPrimaryWindowIds.includes(group.primaryWindowId);
}

function nativePaneLaunchToken(surfaceId: string, paneId: number, targetId: string, targetEpoch: number): string {
  return `${surfaceId}:${paneId}:${targetId}:${targetEpoch}`;
}

function nativePaneWindowGroupPolicy(): NonNullable<NativePaneMaterialization["panes"][number]["windowGroup"]>["policy"] {
  return {
    chromeInsets: NATIVE_PANE_CHROME_REACHABILITY_INSETS,
    clipToPane: true,
    constrainToPane: true,
    denyForeignToplevels: true,
    sameLaunchSecondaryToplevels: "accept",
  };
}

function resolvePaneGeometrySnapshots(surface: SurfaceState, viewport: SurfaceViewport = surface.viewport): Map<number, PaneGeometryProjection> {
  const surfaceBounds: Rect = {
    height: viewport.height,
    width: viewport.width,
    x: 0,
    y: 0,
  };
  const zeroInsets = { bottom: 0, left: 0, right: 0, top: 0 };
  const projections: Array<[number, PaneGeometryProjection]> = [];
  for (const paneId of surface.paneOrder) {
    const pane = surface.panes.get(paneId);
    if (!pane) {
      throw new SurfaceCoreError("internal_error", `Pane ${paneId} is missing state for resolved geometry`);
    }
    const paneFrame = pane.snapshot.bounds &&
      isRenderableRect(pane.snapshot.bounds) &&
      sameOptionalGeometryIdentity(
        paneSnapshotIdentity(pane.snapshot),
        {
          geometryRevision: surface.geometryRevision,
          surfaceEpoch: surface.surfaceEpoch,
          topologyRevision: surface.topologyRevision,
        },
      )
      ? { ...pane.snapshot.bounds }
      : null;
    projections.push([
      paneId,
      paneFrame
        ? authoritativePaneGeometryProjection(surface, pane, paneFrame, surfaceBounds, zeroInsets)
        : unavailablePaneGeometryProjection(surface, pane, surfaceBounds, zeroInsets),
    ]);
  }
  return new Map(projections);
}

function snapshotGeometryIdentity(snapshot: Partial<PaneSnapshot>): ResolvedPaneGeometryIdentity | null {
  return Number.isInteger(snapshot.geometryRevision) &&
    typeof snapshot.surfaceEpoch === "string" &&
    snapshot.surfaceEpoch.length > 0 &&
    Number.isInteger(snapshot.topologyRevision)
    ? {
        geometryRevision: snapshot.geometryRevision!,
        surfaceEpoch: snapshot.surfaceEpoch,
        topologyRevision: snapshot.topologyRevision!,
      }
    : null;
}

function paneSnapshotIdentity(snapshot: PaneSnapshot): ResolvedPaneGeometryIdentity | null {
  return snapshotGeometryIdentity(snapshot);
}

function sameGeometryIdentity(
  left: ResolvedPaneGeometryIdentity,
  right: ResolvedPaneGeometryIdentity,
): boolean {
  return left.geometryRevision === right.geometryRevision &&
    left.surfaceEpoch === right.surfaceEpoch &&
    left.topologyRevision === right.topologyRevision;
}

function sameOptionalGeometryIdentity(
  left: ResolvedPaneGeometryIdentity | null,
  right: ResolvedPaneGeometryIdentity | null,
): boolean {
  return left !== null && right !== null && sameGeometryIdentity(left, right);
}

function authoritativePaneGeometryProjection(
  surface: SurfaceState,
  pane: PaneState,
  paneFrame: Rect,
  surfaceBounds: Rect,
  zeroInsets: { bottom: number; left: number; right: number; top: number },
): PaneGeometryProjection {
  const contentViewport = { ...paneFrame };
  return {
    contentViewport,
    coordinateSpace: "surface_logical",
    geometryRevision: surface.geometryRevision as Revision,
    paneFrame: { ...paneFrame },
    paneId: pane.paneId as PaneId,
    paneInstanceId: pane.paneLineageId,
    protocolViewport: {
      coordinateSpace: "protocol_viewport",
      rect: { ...contentViewport },
      viewport: {
        height: contentViewport.height,
        scale: surface.viewport.scale,
        width: contentViewport.width,
      },
    },
    safeAreaInsets: { ...zeroInsets },
    scale: surface.viewport.scale,
    splitSpacingInsets: { ...zeroInsets },
    surfaceBounds: { ...surfaceBounds },
    surfaceEpoch: surface.surfaceEpoch,
    topologyEpoch: surface.topologyRevision as TopologyRevision,
  };
}

function unavailablePaneGeometryProjection(
  surface: SurfaceState,
  pane: PaneState,
  surfaceBounds: Rect,
  zeroInsets: { bottom: number; left: number; right: number; top: number },
): PaneGeometryProjection {
  const placeholderRect = { ...surfaceBounds };
  return {
    contentViewport: { ...placeholderRect },
    coordinateSpace: "surface_logical",
    geometryRevision: 0 as Revision,
    geometryUnavailable: true,
    paneFrame: { ...placeholderRect },
    paneId: pane.paneId as PaneId,
    paneInstanceId: pane.paneLineageId,
    protocolViewport: {
      coordinateSpace: "protocol_viewport",
      rect: { ...placeholderRect },
      viewport: {
        height: placeholderRect.height,
        scale: surface.viewport.scale,
        width: placeholderRect.width,
      },
    },
    safeAreaInsets: { ...zeroInsets },
    scale: surface.viewport.scale,
    splitSpacingInsets: { ...zeroInsets },
    surfaceBounds: { ...surfaceBounds },
    surfaceEpoch: surface.surfaceEpoch,
    topologyEpoch: surface.topologyRevision as TopologyRevision,
    unavailableReason: "missing_resolved_snapshot",
  };
}

function isRenderableRect(rect: Rect): boolean {
  return Number.isFinite(rect.height) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    rect.height > 0 &&
    rect.width > 0;
}

function compositorResolvedRect(rect: Rect): Rect {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const right = Math.round(rect.x + rect.width);
  const bottom = Math.round(rect.y + rect.height);
  return {
    height: Math.max(1, bottom - y),
    width: Math.max(1, right - x),
    x,
    y,
  };
}

function bumpGeometryRevision(
  surface: SurfaceState,
  options: { rotateSurfaceEpoch?: boolean } = {},
): void {
  surface.geometryRevision += 1;
  if (options.rotateSurfaceEpoch) {
    surface.surfaceEpochRevision += 1;
    surface.surfaceEpoch = `${surface.surfaceId}:${surface.surfaceEpochRevision}`;
  }
}

function sameRect(left: Rect, right: Rect): boolean {
  return (
    Math.abs(left.height - right.height) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5 &&
    Math.abs(left.x - right.x) < 0.5 &&
    Math.abs(left.y - right.y) < 0.5
  );
}

function nearestPaneInDirection(
  activePaneId: number,
  active: Rect,
  paneGeometry: Map<number, PaneGeometryProjection>,
  direction: PaneNavigationDirection,
): number | null {
  const activeCenter = rectCenter(active);
  const candidates = [...paneGeometry.values()]
    .filter((pane) => pane.paneId !== activePaneId)
    .map((pane) => {
      const rect = pane.paneFrame;
      const center = rectCenter(rect);
      const deltaX = center.x - activeCenter.x;
      const deltaY = center.y - activeCenter.y;
      const primaryDistance =
        direction === "left" ? -deltaX :
        direction === "right" ? deltaX :
        direction === "up" ? -deltaY :
        deltaY;
      if (primaryDistance <= 0) {
        return null;
      }
      const overlap = direction === "left" || direction === "right"
        ? intervalOverlap(active.y, active.y + active.height, rect.y, rect.y + rect.height)
        : intervalOverlap(active.x, active.x + active.width, rect.x, rect.x + rect.width);
      const secondaryDistance = direction === "left" || direction === "right"
        ? Math.abs(deltaY)
        : Math.abs(deltaX);
      return {
        overlap,
        paneId: Number(pane.paneId),
        primaryDistance,
        secondaryDistance,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => {
      const overlapDelta = Number(right.overlap > 0) - Number(left.overlap > 0);
      if (overlapDelta !== 0) {
        return overlapDelta;
      }
      return (
        left.primaryDistance - right.primaryDistance ||
        left.secondaryDistance - right.secondaryDistance ||
        left.paneId - right.paneId
      );
    });

  return candidates[0]?.paneId ?? null;
}

function rectCenter(rect: Rect): { x: number; y: number } {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function intervalOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): number {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function formatRect(rect: Rect): string {
  return `{x:${rect.x},y:${rect.y},width:${rect.width},height:${rect.height}}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: Record<string, unknown>): value is Record<string, string> {
  return Object.values(value).every((entry) => typeof entry === "string");
}

function patchHtml(
  html: string,
  patch: ContentPatchRequest["payload"]["patch"],
): string {
  const { document } = parseHTML(`<body>${html}</body>`);
  const target = document.querySelector(patch.selector);
  if (!target) {
    throw new SurfaceCoreError("render_failed", `Patch selector not found: ${patch.selector}`);
  }

  switch (patch.action) {
    case "replace_inner":
      target.innerHTML = patch.html ?? "";
      break;
    case "replace_outer":
      target.outerHTML = patch.html ?? "";
      break;
    case "insert_before":
      target.insertAdjacentHTML("beforebegin", patch.html ?? "");
      break;
    case "insert_after":
      target.insertAdjacentHTML("afterend", patch.html ?? "");
      break;
    case "remove":
      target.remove();
      break;
  }

  return document.body.innerHTML;
}

function firstPointTimestamp(stroke: Stroke): number {
  return stroke.points[0]?.timestamp ?? Date.now();
}

function lastPointTimestamp(stroke: Stroke): number {
  return stroke.points[stroke.points.length - 1]?.timestamp ?? Date.now();
}
