import { annotationDoneContextKey, parseAnnotationDoneContext, type AnnotationDoneContext } from "./annotation-done-context.js";
import type { PersistentSurfaceState } from "./surface-core.js";
export const ANNOTATION_LOCAL_SAVE_MAX_BYTES = 1024;
export const ANNOTATION_LOCAL_SAVE_LIMIT = 64;
export type AnnotationLocalSave = { version: 1; frameId: string; context: AnnotationDoneContext };
export type ConfirmedAnnotationLocalSaveCandidate = {
  surfaceId: string;
  paneId: number;
  annotating: boolean;
  frameId?: string;
  localSave?: unknown;
  context: unknown;
};
export function validLocalAnnotationFrameId(value: unknown): value is string {
  return typeof value === "string" && /^lf_[a-f0-9]{32}$/.test(value);
}
/** This is candidate metadata, not proof until its exact state is confirmed durable. */
export function parseAnnotationLocalSave(value: unknown): AnnotationLocalSave | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const context = parseAnnotationDoneContext(v.context);
  if (v.version !== 1 || !validLocalAnnotationFrameId(v.frameId) || !context ||
      Object.keys(v).sort().join(",") !== "context,frameId,version" ||
      Object.keys(v.context as object).sort().join(",") !== "contentId,paneId,paneLineageId,renderVersion,revision" ||
      context.paneLineageId.length > 256 || (context.contentId?.length ?? 0) > 256) return null;
  const record: AnnotationLocalSave = { version: 1, frameId: v.frameId, context };
  return Buffer.byteLength(JSON.stringify(record), "utf8") <= ANNOTATION_LOCAL_SAVE_MAX_BYTES ? record : null;
}
/** Fed only acknowledged writes or verified state loads/reconciliation, never staged core state. */
export class ConfirmedAnnotationLocalSaves {
  private readonly records = new Map<string, AnnotationLocalSave>();
  confirm(state: PersistentSurfaceState): void {
    this.confirmCandidates((state.surfaces ?? []).flatMap((surface) => surface.panes.map((pane) => {
      const entry = pane.history[pane.historyIndex];
      return {
        surfaceId: surface.surfaceId,
        paneId: pane.paneId,
        annotating: pane.annotating,
        frameId: pane.annotationLocalFrameId,
        localSave: pane.annotationLocalSave,
        context: entry ? {
          contentId: entry.contentId,
          paneId: pane.paneId,
          paneLineageId: pane.paneLineageId,
          renderVersion: pane.latestContentEventAt,
          revision: entry.revision,
        } : null,
      };
    })));
  }

  confirmCandidates(candidates: readonly ConfirmedAnnotationLocalSaveCandidate[]): void {
    this.records.clear();
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      if (this.records.size >= 4096) break;
      const count = counts.get(candidate.surfaceId) ?? 0;
      if (count >= ANNOTATION_LOCAL_SAVE_LIMIT) continue;
      const record = parseAnnotationLocalSave(candidate.localSave);
      const context = parseAnnotationDoneContext(candidate.context);
      if (candidate.annotating || !record || !context || record.frameId !== candidate.frameId ||
          annotationDoneContextKey(record.context) !== annotationDoneContextKey(context)) continue;
      this.records.set(JSON.stringify([candidate.surfaceId, candidate.paneId]), record);
      counts.set(candidate.surfaceId, count + 1);
    }
  }
  has(surfaceId: string, context: AnnotationDoneContext, frameId: string | undefined): boolean {
    const record = this.records.get(JSON.stringify([surfaceId, context.paneId]));
    return !!record && record.frameId === frameId &&
      annotationDoneContextKey(record.context) === annotationDoneContextKey(context);
  }
}
