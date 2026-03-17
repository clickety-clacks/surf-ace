export const surfAceToolNames = [
  "surf_ace_list",
  "surf_ace_push",
  "surf_ace_read",
  "surf_ace_snapshot",
  "surf_ace_annotate_remove",
] as const;

export type SurfAceToolName = (typeof surfAceToolNames)[number];

export function register(): void {}
