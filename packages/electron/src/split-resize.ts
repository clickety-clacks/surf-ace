export type SplitResizeExpectation = {
  surfaceEpoch: string;
  topologyRevision: number;
  geometryRevision: number;
  layout: unknown;
};

export function splitResizeMatches(
  current: SplitResizeExpectation,
  expected: SplitResizeExpectation,
): boolean {
  return typeof expected.surfaceEpoch === "string" &&
    Number.isSafeInteger(expected.topologyRevision) &&
    Number.isSafeInteger(expected.geometryRevision) &&
    current.surfaceEpoch === expected.surfaceEpoch &&
    current.topologyRevision === expected.topologyRevision &&
    current.geometryRevision === expected.geometryRevision &&
    JSON.stringify(current.layout) === JSON.stringify(expected.layout);
}

export function splitResizeIsNoOp(layout: unknown, path: number[], weights: number[]): boolean {
  let node = layout as { type?: string; children?: unknown[]; weight?: number } | null;
  for (const index of path) {
    if (node?.type !== "split" || !Number.isSafeInteger(index) || index < 0) return false;
    node = node.children?.[index] as typeof node;
  }
  if (node?.type !== "split" || node.children?.length !== weights.length || !weights.length ||
      weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) return false;
  const original = node.children.map((child) => {
    const weight = (child as { weight?: number }).weight;
    return typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? weight : 1;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const oldTotal = original.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || !Number.isFinite(oldTotal)) return false;
  return original.every((weight, index) => Math.abs(weight / oldTotal - weights[index]! / total) < 1e-9);
}

export type SplitResizeGeometry = { paneId: number; bounds: { x: number; y: number; width: number; height: number } };

export function splitResizeGeometryIsValid(value: unknown, paneIds: number[]): value is SplitResizeGeometry[] {
  if (!Array.isArray(value) || value.length !== paneIds.length) return false;
  const seen = new Set<number>();
  return value.every((entry) => {
    if (!entry || !Number.isSafeInteger(entry.paneId) || !paneIds.includes(entry.paneId) || seen.has(entry.paneId)) return false;
    seen.add(entry.paneId);
    const b = entry.bounds;
    return b && [b.x, b.y, b.width, b.height].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e6) && b.width > 0 && b.height > 0;
  });
}
