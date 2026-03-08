/**
 * Surf Ace extension entrypoint (fresh WS-era rebuild).
 *
 * Source of truth: ../../DESIGN.md
 */

export type SurfAceExtensionStatus = {
  mode: "ws-rebuild";
  designDoc: "DESIGN.md";
};

export function getSurfAceExtensionStatus(): SurfAceExtensionStatus {
  return {
    mode: "ws-rebuild",
    designDoc: "DESIGN.md",
  };
}
