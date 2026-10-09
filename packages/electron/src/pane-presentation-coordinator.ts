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
  constructor(
    private readonly core: SurfaceCore,
    private readonly transportForSurface: (surfaceId: string) => Sender | null,
  ) {}

  async apply(surfaceId: string, presentation: Presentation | null, expected: Identity): Promise<number> {
    const selected = presentation === null ? null : structuredClone(presentation);
    const identity = structuredClone(expected);
    this.assertCurrent(surfaceId, identity, selected);
    const revision = (this.revisions.get(surfaceId) ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("pane presentation revision exhausted");
    this.revisions.set(surfaceId, revision);
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
        materialization, revision,
        selected ? { paneId: selected.paneId, paneLineageId: selected.paneLineageId } : null,
        bounds, content,
      );
      await acknowledgePanePresentation(send, acknowledged);
    } else if (nativeIds.length > 0) {
      throw new Error("native pane presentation requires its routed compositor host");
    }
    if (this.revisions.get(surfaceId) !== revision) throw new Error("pane presentation was superseded");
    this.assertCurrent(surfaceId, identity, selected);
    if (acknowledged) {
      const currentNativeIds = this.core.getRendererWindowState(surfaceId).panes
        .filter((pane) => pane.externalNative).map((pane) => pane.paneId);
      const current = panePresentationRequest(
        this.core.projectCurrentNativePaneGeometry(surfaceId, currentNativeIds), revision,
        selected ? { paneId: selected.paneId, paneLineageId: selected.paneLineageId } : null,
        acknowledged.request.overlay_rect, acknowledged.request.content_rect,
      ).request;
      const { version, request_revision, presentation_generation, selected: currentSelection } = current;
      assertPanePresentationAcknowledged({ ok: true, pane_presentation: {
        version, request_revision, presentation_generation, selected: currentSelection,
      } }, acknowledged);
    }
    this.core.setPanePresentation(surfaceId, selected);
    return revision;
  }

  invalidate(surfaceId: string): void {
    this.revisions.set(surfaceId, (this.revisions.get(surfaceId) ?? 0) + 1);
    this.core.setPanePresentation(surfaceId, null);
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
