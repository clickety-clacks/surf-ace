import { randomBytes, randomUUID } from "node:crypto";

import { parseHTML } from "linkedom";

import type {
  AnnotationCommittedEvent,
  ContentApplyRequest,
  ContentApplyResponse,
  ContentAppendRequest,
  ContentClearRequest,
  ContentId,
  ContentPatchRequest,
  ContentSetRequest,
  ContentType,
  DrawingFlushConfig,
  DrawingFlushEvent,
  EpochMs,
  HistoryNavigatedEvent,
  MutationAckResponse,
  PaneCloseResponse,
  PaneCreatedEvent,
  PaneId,
  PaneRemovedEvent,
  PaneRenamedEvent,
  PairResponse,
  PanesListResponse,
  Position,
  Revision,
  Selection,
  SnapshotResponse,
  Stroke,
  StrokeId,
  SurfaceId,
  SurfaceViewport,
  TargetApplyRequest,
  TargetApplyResponse,
  PaneTargetState,
  TopologyApplyRequest,
  TopologyApplyResponse,
} from "../../protocol/src/index.js";

type ContentPayload = ContentSetRequest["payload"]["content"];
type ContentDisplay = ContentSetRequest["payload"]["display"];
type BrowserUrlPayload = { url: string; allowedSnapshotFallback?: boolean; fallbackSnapshotTargetId?: string };
type RenderableContentType = ContentType | "browser_url";
type RenderablePayload = ContentPayload | BrowserUrlPayload;

type HistoryEntry = {
  annotations: Stroke[];
  content: RenderablePayload | null;
  contentId: string | null;
  contentType: RenderableContentType | null;
  display?: ContentDisplay;
  ownerToken: string | null;
  revision: number;
  targetState?: PaneTargetState | null;
};

type PaneSnapshot = {
  bounds: { height: number; width: number; x: number; y: number } | null;
  selection: Selection;
  viewport: SnapshotResponse["payload"]["viewport"];
  visibleText: string;
};

type PaneState = {
  annotating: boolean;
  annotationFrameOpen: boolean;
  deliveredClosedFrameCount: number;
  dirtyStrokeIds: string[];
  firstDirtyStrokeAt: number | null;
  flushInFlight: boolean;
  history: HistoryEntry[];
  historyIndex: number;
  lastDirtyStrokeAt: number | null;
  lastSuccessfulFlushAt: number | null;
  latestContentEventAt: number;
  name: string | null;
  paneId: number;
  paneLineageId: string;
  paneLabel: number;
  pendingAnnotationCommit: boolean;
  snapshot: PaneSnapshot;
  toast: string | null;
};

type LayoutNode =
  | {
      paneId: number;
      type: "pane";
    }
  | {
      children: LayoutNode[];
      direction: "horizontal" | "vertical";
      type: "split";
    };

type SurfaceState = {
  connectionBar: "connected" | "connecting" | "disconnected";
  layout: LayoutNode | null;
  name: string;
  paneOrder: number[];
  panes: Map<number, PaneState>;
  providerName: string | null;
  surfaceId: string;
  topologyRevision: number;
  viewport: SurfaceViewport;
  windowLabel: string;
};

export type PersistentSurfaceState = {
  primarySurfaceId: string | null;
  version: 1;
};

export type RendererPaneState = {
  annotationBorderVisible: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  content: {
    content: RenderablePayload | null;
    contentId: string | null;
    contentType: RenderableContentType | null;
    display?: ContentDisplay;
    revision: number;
  };
  drawings: Stroke[];
  flushInFlight: boolean;
  label: string;
  name: string | null;
  paneId: number;
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
  viewport: SurfaceViewport;
  windowLabel: string;
};

export type CoreEvent =
  | { surfaceId: string; type: "surface-changed" }
  | { surfaceId: string; type: "surface-created" }
  | { surfaceId: string; type: "surface-removed" }
  | { fromSplit: boolean; paneId: number; paneLabel: number; parentPaneId: number | null; surfaceId: string; type: "pane-created" }
  | { paneId: number; surfaceId: string; type: "pane-removed" }
  | { name: string | null; paneId: number; surfaceId: string; type: "pane-renamed" }
  | { paneId: number; surfaceId: string; type: "annotation-committed" }
  | { contentId: string | null; direction: "back" | "forward"; paneId: number; revision: number; surfaceId: string; type: "history-navigated" }
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
  private readonly surfaces = new Map<string, SurfaceState>();
  private readonly listeners = new Set<(event: CoreEvent) => void>();
  private readonly logger: { warn?: (message: string) => void };
  private readonly now: () => number;
  private persistentState: PersistentSurfaceState;

  constructor(options?: {
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
  }

  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getPersistentState(): PersistentSurfaceState {
    return structuredClone(this.persistentState);
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

    const surfaceId = existingId ?? `sf_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
    return {
      connectionBar: surface.connectionBar,
      layout: surface.layout ? structuredClone(surface.layout) : null,
      name: surface.name,
      panes: surface.paneOrder.map((paneId) => {
        const pane = surface.panes.get(paneId)!;
        const current = currentEntry(pane);
        return {
          annotationBorderVisible: pane.annotating,
          canGoBack: pane.historyIndex > 0,
          canGoForward: pane.historyIndex < pane.history.length - 1,
          content: {
            content: cloneContent(current.content),
            contentId: current.contentId,
            contentType: current.contentType,
          display: current.display ? { ...current.display } : undefined,
          revision: current.revision,
        },
        drawings: structuredClone(current.annotations),
        flushInFlight: pane.flushInFlight,
        label: pane.paneLabel > 0 ? String(pane.paneLabel) : "",
        name: pane.name,
        paneId,
        showDone: pane.annotating,
          toast: pane.toast,
        };
      }),
      providerName: surface.providerName,
      surfaceId: surface.surfaceId,
      viewport: cloneViewport(surface.viewport),
      windowLabel: surface.windowLabel,
    };
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
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return;
    }
    if (pane.annotating === enabled) {
      return;
    }
    pane.annotating = enabled;
    pane.toast = null;
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

    pane.toast = null;
    clearDirtyState(pane);
    this.emit({ surfaceId, type: "surface-changed" });
    this.emit({
      contentId: currentEntry(pane).contentId,
      direction,
      paneId,
      revision: currentEntry(pane).revision,
      surfaceId,
      type: "history-navigated",
    });
  }

  panesList(surfaceId: string): PanesListResponse["payload"] {
    const surface = this.getSurface(surfaceId);
    const paneViewports = layoutPaneViewports(surface.layout!, surface.viewport);
    return {
      panes: surface.paneOrder.map((paneId) => {
        const pane = surface.panes.get(paneId)!;
        const current = currentEntry(pane);
        return {
          activeContentId: protocolContentId(current),
          contentType: protocolContentType(current),
          currentTarget: current.targetState ?? null,
          name: pane.name,
          paneId: pane.paneId as PaneId,
          paneLineageId: pane.paneLineageId,
          paneLabel: pane.paneLabel,
          viewport: paneViewports.get(paneId) ?? structuredClone(pane.snapshot.viewport),
        };
      }),
    };
  }

  pairState(surfaceId: string): PairResponse["payload"]["state"] {
    const surface = this.getSurface(surfaceId);
    return {
      panes: surface.paneOrder.map((paneId) => {
        const pane = surface.panes.get(paneId)!;
        const current = currentEntry(pane);
        return {
          contentType: protocolContentType(current),
          currentContentId: protocolContentId(current),
          currentTarget: current.targetState ?? null,
          currentRevision: current.revision as Revision,
          paneId: pane.paneId as PaneId,
          paneLineageId: pane.paneLineageId,
          paneLabel: pane.paneLabel,
        };
      }),
    };
  }

  applyWindowLabelOnly(surfaceId: string, windowLabel: string): void {
    const surface = this.getSurface(surfaceId);
    if (surface.windowLabel !== windowLabel) {
      surface.windowLabel = windowLabel;
      this.emit({ surfaceId, type: "surface-changed" });
    }
  }

  applyProviderBootstrapTopology(
    surfaceId: string,
    payload: { initialPaneId: number; initialPaneLabel: number; windowLabel: string },
  ): void {
    const surface = this.getSurface(surfaceId);
    let didChange = false;

    if (surface.windowLabel !== payload.windowLabel) {
      surface.windowLabel = payload.windowLabel;
      didChange = true;
    }

    if (this.ensureInitialPane(surface, payload.initialPaneId, payload.initialPaneLabel)) {
      didChange = true;
    }

    if (didChange) {
      this.emit({ surfaceId, type: "surface-changed" });
    }
  }

  topologyApply(
    surfaceId: string,
    payload: TopologyApplyRequest["payload"],
  ): TopologyApplyResponse["payload"] {
    const surface = this.getSurface(surfaceId);
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
    surface.paneOrder = orderedPanes;
    surface.panes = nextPanes;
    surface.topologyRevision = Number(payload.topologyRevision);
    surface.windowLabel = payload.windowLabel;
    this.emit({ surfaceId, type: "surface-changed" });

    return {
      panes: orderedPanes.map((paneId) => {
        const pane = nextPanes.get(paneId)!;
        return {
          name: pane.name,
          paneId: pane.paneId as PaneId,
          paneLineageId: pane.paneLineageId,
          paneLabel: pane.paneLabel,
        };
      }),
      topologyRevision: payload.topologyRevision,
    };
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
      if (current.revision > payload.revision) {
        throw new SurfaceCoreError("stale_revision", `Expected revision >= ${current.revision}`, {
          expectedRevision: current.revision,
        });
      }
      if (current.revision === payload.revision && current.contentId === null) {
        return {
          ...currentMutationAck(pane),
          topologyRevision: payload.topologyRevision,
        };
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
    if (current.revision > payload.revision) {
      throw new SurfaceCoreError("stale_revision", `Expected revision >= ${current.revision}`, {
        expectedRevision: current.revision,
      });
    }
    if (current.revision === payload.revision && current.contentId === payload.contentId) {
      return {
        ...currentMutationAck(pane),
        topologyRevision: payload.topologyRevision,
      };
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
    const surface = this.getSurface(surfaceId);
    if (payload.surfaceId !== surface.surfaceId) {
      return targetApplyResult(payload, "rejected", "materialization_failed", "target surfaceId does not match this surface");
    }
    if (!payload.targetHeader.requiredCapabilities.every((capability) =>
      (SUPPORTED_TARGET_CAPABILITIES as readonly string[]).includes(capability)
    )) {
      return targetApplyResult(payload, "rejected", "capability_missing", "required target capability is not advertised");
    }
    if (payload.targetKind !== "browser_url") {
      return targetApplyResult(payload, "rejected", "unsupported_target_kind", "unsupported target kind");
    }
    if (payload.targetHeader.replaySemantics !== "navigate") {
      return targetApplyResult(payload, "rejected", "unsafe_payload", "browser_url requires navigate replay semantics");
    }
    const targetPayload = payload.targetPayload as Partial<BrowserUrlPayload>;
    if (typeof targetPayload.url !== "string" || targetPayload.url.trim() === "") {
      return targetApplyResult(payload, "rejected", "unsafe_payload", "browser_url targetPayload.url is required");
    }
    const url = parseSafeBrowserUrl(targetPayload.url);
    if (!url) {
      return targetApplyResult(payload, "rejected", "unsafe_payload", "browser_url targetPayload.url must be http or https");
    }
    const pane = paneForLineage(surface, payload.paneLineageId);
    if (!pane) {
      return targetApplyResult(payload, "rejected", "pane_lineage_missing", "pane lineage is unknown");
    }
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      return targetApplyResult(payload, "rejected", "policy_denied", "annotation mode is active");
    }

    if (pane.historyIndex < pane.history.length - 1) {
      pane.history = pane.history.slice(0, pane.historyIndex + 1);
    }
    pane.history.push({
      annotations: [],
      content: {
        ...(targetPayload.allowedSnapshotFallback === undefined ? {} : { allowedSnapshotFallback: targetPayload.allowedSnapshotFallback }),
        ...(targetPayload.fallbackSnapshotTargetId === undefined ? {} : { fallbackSnapshotTargetId: targetPayload.fallbackSnapshotTargetId }),
        url: url.toString(),
      },
      contentId: payload.targetId,
      contentType: "browser_url",
      ownerToken: null,
      revision: payload.targetEpoch,
      targetState: {
        currentState: "current",
        paneLineageId: payload.paneLineageId,
        restorePolicy: payload.restoreReason === "initial_apply" ? "confirm" : "auto",
        targetEpoch: payload.targetEpoch,
        targetId: payload.targetId,
        targetKind: "browser_url",
      },
    });
    pane.historyIndex = pane.history.length - 1;
    trimHistory(pane);
    pane.toast = null;
    pane.latestContentEventAt = this.now();
    clearDirtyState(pane);
    this.emit({ surfaceId, type: "surface-changed" });
    return targetApplyResult(payload, "applied", undefined, "browser_url navigation started; success is reported asynchronously by surface diagnostics", {
      navigationStatus: "started_unverified",
      replaySemantics: "navigate",
      url: url.toString(),
    });
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
    pane.latestContentEventAt = this.now();
    clearDirtyState(pane);
    this.emit({ surfaceId, type: "surface-changed" });

    return currentMutationAck(pane);
  }

  contentClear(surfaceId: string, payload: ContentClearRequest["payload"]): MutationAckResponse["payload"] {
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
    pane.latestContentEventAt = this.now();
    clearDirtyState(pane);
    this.emit({ surfaceId, type: "surface-changed" });
    return currentMutationAck(pane);
  }

  contentAppend(surfaceId: string, payload: ContentAppendRequest["payload"]): MutationAckResponse["payload"] {
    const pane = this.expectPane(surfaceId, payload.paneId);
    const entry = currentEntry(pane);
    assertRevision(pane, payload.revision);
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
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return;
    }
    pane.snapshot = {
      bounds: snapshot.bounds ?? pane.snapshot.bounds,
      selection: snapshot.selection ?? pane.snapshot.selection,
      viewport: snapshot.viewport ?? pane.snapshot.viewport,
      visibleText: snapshot.visibleText ?? pane.snapshot.visibleText,
    };
  }

  captureSnapshot(surfaceId: string, paneId: number): SnapshotResponse["payload"] {
    const pane = this.expectPane(surfaceId, paneId);
    const current = currentEntry(pane);
    return {
      contentId: protocolContentId(current),
      contentType: protocolContentType(current),
      currentTarget: current.targetState ?? null,
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

  applyNavigation(surfaceId: string, paneId: number, url: string): { blocked: boolean } {
    const pane = this.requirePane(surfaceId, paneId);
    if (!pane) {
      return { blocked: false };
    }
    if (pane.annotating) {
      pane.toast = "Finish annotation (Done) to navigate";
      this.emit({ surfaceId, type: "surface-changed" });
      return { blocked: true };
    }
    pane.toast = null;
    this.emit({ surfaceId, type: "surface-changed" });
    return { blocked: false };
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
      connectionBar: "disconnected",
      layout: { paneId: BOOTSTRAP_PANE_ID, type: "pane" },
      name,
      paneOrder: [BOOTSTRAP_PANE_ID],
      panes: new Map([[BOOTSTRAP_PANE_ID, bootstrapPane]]),
      providerName: null,
      surfaceId,
      topologyRevision: 0,
      viewport: cloneViewport(viewport),
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
    for (const listener of this.listeners) {
      listener(event);
    }
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
    flushInFlight: false,
    history: [
      {
        annotations: [],
        content: null,
        contentId: null,
        contentType: null,
        ownerToken: null,
        revision: 0,
        targetState: null,
      },
    ],
    historyIndex: 0,
    lastDirtyStrokeAt: null,
    lastSuccessfulFlushAt: now,
    latestContentEventAt: now,
    name: null,
    paneId,
    paneLineageId: makePaneLineageId(),
    paneLabel,
    pendingAnnotationCommit: false,
    snapshot: {
      bounds: null,
      selection: null,
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

function currentEntry(pane: PaneState): HistoryEntry {
  return pane.history[pane.historyIndex]!;
}

function makePaneLineageId(): string {
  return `pl_${randomBytes(8).toString("hex")}`;
}

function paneForLineage(surface: SurfaceState, lineageId: string): PaneState | null {
  return [...surface.panes.values()].find((pane) => pane.paneLineageId === lineageId) ?? null;
}

function protocolContentId(entry: HistoryEntry): ContentId | null {
  return entry.contentType === "browser_url" ? null : entry.contentId as ContentId | null;
}

function protocolContentType(entry: HistoryEntry): ContentType | null {
  return entry.contentType === "browser_url" ? null : entry.contentType as ContentType | null;
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
  materializedState?: Record<string, unknown>,
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

function cloneContent(content: ContentPayload | null): ContentPayload | null {
  return content ? structuredClone(content) : null;
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
  if (snapshotText && snapshotText !== "Surface readyWaiting for content.") {
    return snapshotText;
  }
  return htmlVisibleText(entry.content as HtmlContent) ?? snapshotText;
}

function currentMutationAck(pane: PaneState): MutationAckResponse["payload"] {
  const entry = currentEntry(pane);
  return {
    contentId: entry.contentId,
    contentType: entry.contentType,
    currentContentId: entry.contentId,
    currentRevision: entry.revision as Revision,
    paneId: pane.paneId as PaneId,
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
    };
  }

  return {
    children: node.children.map((child) => topologyLayoutToSurfaceLayout(child, paneStateById)),
    direction: node.direction,
    type: "split",
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

function layoutPaneViewports(
  node: LayoutNode,
  viewport: SurfaceViewport,
): Map<number, SurfaceViewport> {
  const byPaneId = new Map<number, SurfaceViewport>();

  const visit = (current: LayoutNode, currentViewport: SurfaceViewport): void => {
    if (current.type === "pane") {
      byPaneId.set(current.paneId, cloneViewport(currentViewport));
      return;
    }

    const childCount = current.children.length || 1;
    for (const child of current.children) {
      visit(
        child,
        current.direction === "horizontal"
          ? {
              height: currentViewport.height,
              scale: currentViewport.scale,
              width: currentViewport.width / childCount,
            }
          : {
              height: currentViewport.height / childCount,
              scale: currentViewport.scale,
              width: currentViewport.width,
            },
      );
    }
  };

  visit(node, viewport);
  return byPaneId;
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
