export type AnnotationDoneContext = {
  paneId: number;
  paneLineageId: string;
  contentId: string | null;
  revision: number;
  renderVersion: number;
};

export function parseAnnotationDoneContext(value: unknown): AnnotationDoneContext | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (!Number.isSafeInteger(p.paneId) || (p.paneId as number) <= 0 ||
      typeof p.paneLineageId !== "string" || !p.paneLineageId ||
      !(p.contentId === null || typeof p.contentId === "string") ||
      !Number.isSafeInteger(p.revision) || (p.revision as number) < 0 ||
      typeof p.renderVersion !== "number" || !Number.isFinite(p.renderVersion)) return null;
  return { paneId: p.paneId as number, paneLineageId: p.paneLineageId,
    contentId: p.contentId as string | null, revision: p.revision as number, renderVersion: p.renderVersion };
}

export function annotationDoneContextKey(context: AnnotationDoneContext): string {
  return JSON.stringify([context.paneId, context.paneLineageId, context.contentId,
    context.revision, context.renderVersion]);
}
