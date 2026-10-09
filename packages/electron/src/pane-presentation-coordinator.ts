import { SurfaceCore } from "./surface-core.js";
import { acknowledgePanePresentation, assertPanePresentationAcknowledged, panePresentationRequest,
  type PanePresentationControlRequest } from "./pane-presentation.js";
import type { CompositorControlRequest, CompositorControlResponse } from "./native-pane-bridge.js";

type Presentation = NonNullable<Parameters<SurfaceCore["setPanePresentation"]>[1]>;
type Sender = (request: CompositorControlRequest) => Promise<CompositorControlResponse>;
type Identity = ReturnType<SurfaceCore["resolvedPaneGeometryIdentity"]>;

/** The transport must be independently routed to this renderer window's host. */
export class PanePresentationCoordinator {
  private readonly revisions = new Map<string, number>();
  private readonly wireRevisions = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly accepted = new Map<string, { control: PanePresentationControlRequest; send: Sender; uncertain?: boolean }>();
  private readonly authorities = new Map<string, { identity: Identity; selected: Presentation | null }>();
  constructor(
    private readonly core: SurfaceCore,
    private readonly transportForSurface: (surfaceId: string) => Sender | null,
    private readonly onRetirementFailure: (surfaceId: string, error: unknown) => void = () => {},
  ) {
    core.subscribe((event) => {
      if (event.type === "surface-removed") {
        void this.invalidate(event.surfaceId).catch((error) => onRetirementFailure(event.surfaceId, error));
      } else if (event.type === "surface-changed" || event.type === "pane-removed") {
        void this.reconcileAuthority(event.surfaceId).catch((error) => onRetirementFailure(event.surfaceId, error));
      }
    });
  }

  /** Sender-to-surface routing belongs to main; renderer never supplies surface or lineage authority. */
  async applyRendererRequest(surfaceId: string, payload: unknown): Promise<number> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid pane presentation request");
    }
    const request = payload as Record<string, unknown>;
    const identity = request.identity as Identity;
    if (!identity || typeof identity.surfaceEpoch !== "string" ||
        !Number.isSafeInteger(identity.geometryRevision) || !Number.isSafeInteger(identity.topologyRevision)) {
      throw new Error("invalid pane presentation identity");
    }
    if (request.paneId === null) return this.apply(surfaceId, null, identity);
    if (!Number.isSafeInteger(request.paneId) || Number(request.paneId) <= 0) {
      throw new Error("invalid pane presentation pane");
    }
    const pane = this.core.panesList(surfaceId).panes.find((item) => item.paneId === request.paneId);
    if (!pane) throw new Error("pane presentation pane is absent");
    return this.apply(surfaceId, {
      paneId: pane.paneId, paneLineageId: pane.paneLineageId,
      snapshot: { ...identity, bounds: request.bounds as never,
        viewport: request.viewport as never, selection: null },
    }, identity);
  }

  async apply(surfaceId: string, presentation: Presentation | null, expected: Identity): Promise<number> {
    const selected = presentation === null ? null : structuredClone(presentation);
    const identity = structuredClone(expected);
    this.assertCurrent(surfaceId, identity, selected);
    const revision = (this.revisions.get(surfaceId) ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("pane presentation revision exhausted");
    this.revisions.set(surfaceId, revision);
    this.authorities.set(surfaceId, { identity, selected });
    return this.enqueue(surfaceId, () => this.applySerialized(surfaceId, selected, identity, revision));
  }

  private async applySerialized(surfaceId: string, selected: Presentation | null, identity: Identity, revision: number): Promise<number> {
    if (this.revisions.get(surfaceId) !== revision) throw new Error("pane presentation was superseded");
    this.assertCurrent(surfaceId, identity, selected);
    if (this.accepted.get(surfaceId)?.uncertain) await this.retireAccepted(surfaceId);
    const panes = this.core.getRendererWindowState(surfaceId).panes;
    const nativeIds = panes.filter((pane) => pane.externalNative).map((pane) => pane.paneId);
    const send = this.transportForSurface(surfaceId);
    let acknowledged: PanePresentationControlRequest | null = null;
    if (send) {
      const materialization = this.core.projectCurrentNativePaneGeometry(surfaceId, nativeIds);
      const bounds = selected?.snapshot.bounds ?? null;
      const content = bounds ? { x: bounds.x + 2, y: bounds.y + 2,
        width: bounds.width - 4, height: bounds.height - 4 } : null;
      acknowledged = panePresentationRequest(
        materialization, this.nextWireRevision(surfaceId),
        selected ? { paneId: selected.paneId, paneLineageId: selected.paneLineageId } : null,
        bounds, content,
      );
      let attempted = false;
      try {
        await acknowledgePanePresentation(async (request) => {
          if (request.type === "pane_presentation.set") attempted = true;
          return send(request);
        }, acknowledged);
      } catch (error) {
        // A lost or malformed reply does not prove the compositor did nothing.
        // Require a matching Restore before permitting another transition.
        if (attempted) {
          this.accepted.set(surfaceId, { control: acknowledged, send, uncertain: true });
          await this.retireAccepted(surfaceId).catch((failure) => this.onRetirementFailure(surfaceId, failure));
        }
        throw error;
      }
      if (selected) this.accepted.set(surfaceId, { control: acknowledged, send });
      else this.accepted.delete(surfaceId);
    } else if (nativeIds.length > 0) {
      throw new Error("native pane presentation requires its routed compositor host");
    }
    try {
      if (this.revisions.get(surfaceId) !== revision) throw new Error("pane presentation was superseded");
      this.assertCurrent(surfaceId, identity, selected);
      if (acknowledged) {
        const currentNativeIds = this.core.getRendererWindowState(surfaceId).panes
          .filter((pane) => pane.externalNative).map((pane) => pane.paneId);
        const current = panePresentationRequest(
          this.core.projectCurrentNativePaneGeometry(surfaceId, currentNativeIds), acknowledged.request.request_revision,
          selected ? { paneId: selected.paneId, paneLineageId: selected.paneLineageId } : null,
          acknowledged.request.overlay_rect, acknowledged.request.content_rect,
        ).request;
        const { version, request_revision, presentation_generation, selected: currentSelection } = current;
        assertPanePresentationAcknowledged({ ok: true, pane_presentation: {
          version, request_revision, presentation_generation, selected: currentSelection,
        } }, acknowledged);
      }
    } catch (error) {
      await this.retireAccepted(surfaceId);
      throw error;
    }
    this.core.setPanePresentation(surfaceId, selected);
    return revision;
  }

  invalidate(surfaceId: string): Promise<void> {
    this.revisions.set(surfaceId, (this.revisions.get(surfaceId) ?? 0) + 1);
    this.core.setPanePresentation(surfaceId, null);
    this.authorities.delete(surfaceId);
    return this.enqueue(surfaceId, () => this.retireAccepted(surfaceId));
  }

  private async reconcileAuthority(surfaceId: string): Promise<void> {
    const authority = this.authorities.get(surfaceId);
    if (!authority) return;
    const current = this.core.resolvedPaneGeometryIdentity(surfaceId);
    const pane = authority.selected && this.core.panesList(surfaceId).panes
      .find((item) => item.paneId === authority.selected!.paneId);
    if (current.surfaceEpoch !== authority.identity.surfaceEpoch ||
        current.topologyRevision !== authority.identity.topologyRevision ||
        (authority.selected && (!pane || pane.paneLineageId !== authority.selected.paneLineageId))) {
      await this.invalidate(surfaceId);
    }
  }

  private enqueue<T>(surfaceId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(surfaceId) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(surfaceId, result);
    return result;
  }

  private nextWireRevision(surfaceId: string): number {
    const revision = (this.wireRevisions.get(surfaceId) ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("pane presentation wire revision exhausted");
    this.wireRevisions.set(surfaceId, revision);
    return revision;
  }

  private async retireAccepted(surfaceId: string): Promise<void> {
    const accepted = this.accepted.get(surfaceId);
    if (!accepted) return;
    const restore = structuredClone(accepted.control);
    restore.request.request_revision = this.nextWireRevision(surfaceId);
    restore.request.selected = null;
    restore.request.overlay_rect = null;
    restore.request.content_rect = null;
    // Retire the exact accepted generation even when local authority has moved.
    // Compositor permits only a matching prior-generation Restore tombstone.
    accepted.uncertain = true;
    await acknowledgePanePresentation(accepted.send, restore);
    this.accepted.delete(surfaceId);
  }

  private assertCurrent(surfaceId: string, expected: Identity, selected: Presentation | null): void {
    const current = this.core.resolvedPaneGeometryIdentity(surfaceId);
    if (current.surfaceEpoch !== expected.surfaceEpoch ||
        current.geometryRevision !== expected.geometryRevision ||
        current.topologyRevision !== expected.topologyRevision) {
      throw new Error("pane presentation surface generation is stale");
    }
    if (selected) {
      this.core.validatePanePresentation(surfaceId, selected);
      const pane = this.core.panesList(surfaceId).panes.find((pane) => pane.paneId === selected.paneId);
      if (!pane || pane.paneLineageId !== selected.paneLineageId ||
          selected.snapshot.surfaceEpoch !== expected.surfaceEpoch ||
          selected.snapshot.geometryRevision !== expected.geometryRevision ||
          selected.snapshot.topologyRevision !== expected.topologyRevision) {
        throw new Error("pane presentation lineage or snapshot generation is stale");
      }
    }
  }
}
