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
