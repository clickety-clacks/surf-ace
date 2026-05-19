import type { ToolContext } from "openclaw/plugin-sdk";
import {
  resolveClawlineChatDisplayName,
  type ClawlineChatNameResolverOptions,
} from "./clawline-chat-name-resolver.js";
import type { SurfAceToolContext } from "./surf-ace-tools.js";

export type SurfAceToolContextResolverOptions = {
  baseContext?: SurfAceToolContext;
  clawlineChatNames?: ClawlineChatNameResolverOptions;
};

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

export async function resolveSurfAceToolContextFromOpenClawContext(
  context: ToolContext,
  options: SurfAceToolContextResolverOptions = {},
): Promise<SurfAceToolContext> {
  const baseContext = options.baseContext ?? surfAceToolContextFromOpenClawContext(context);
  const chatName = await resolveClawlineChatDisplayName(
    lookupSessionKeyForClawlineChatName(baseContext),
    options.clawlineChatNames,
  );

  return chatName ? { ...baseContext, sessionDisplayName: chatName } : baseContext;
}

function lookupSessionKeyForClawlineChatName(context: SurfAceToolContext): string | undefined {
  return cleanString(context.sessionKey)
    ?? cleanString(context.sourceProvenance?.sessionKey)
    ?? cleanString(context.provenance?.sessionKey)
    ?? (typeof context.source === "object" ? cleanString(context.source.sessionKey) : undefined)
    ?? cleanString(context.pushedBy?.sessionKey);
}

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
