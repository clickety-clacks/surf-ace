import type { ToolContext } from "openclaw/plugin-sdk";
import type { SurfAceToolContext } from "./surf-ace-tools.js";

export function surfAceToolContextFromOpenClawContext(context: ToolContext): SurfAceToolContext {
  return {
    agentId: context.agentId,
    displayName: context.displayName,
    provenance: context.provenance,
    pushedAt: context.pushedAt,
    pushedBy: context.pushedBy,
    source: context.source ?? "openclaw-plugin",
    sourceProvenance: context.sourceProvenance,
    sessionDisplayName: context.sessionDisplayName,
    sessionKey: context.sessionKey,
    streamLabel: context.streamLabel,
  };
}
