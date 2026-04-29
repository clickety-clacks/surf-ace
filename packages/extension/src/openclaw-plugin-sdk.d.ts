declare module "openclaw/plugin-sdk" {
  export type ToolContext = {
    agentId?: string;
    displayName?: string;
    provenance?: {
      agentId?: string;
      displayName?: string;
      sessionKey?: string;
      source?: string;
      streamLabel?: string;
    };
    pushedBy?: {
      agentId?: string;
      displayName?: string;
      sessionKey?: string;
      source?: string;
      streamLabel?: string;
    };
    source?: string | {
      agentId?: string;
      displayName?: string;
      sessionKey?: string;
      source?: string;
      streamLabel?: string;
    };
    sourceProvenance?: {
      agentId?: string;
      displayName?: string;
      sessionKey?: string;
      source?: string;
      streamLabel?: string;
    };
    sessionDisplayName?: string;
    sessionKey?: string;
    streamLabel?: string;
  };

  export type ToolDefinition = {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (id: string, params: any) => Promise<unknown>;
  };

  export type OpenClawPluginApi = {
    runtime: unknown;
    logger: unknown;
    pluginConfig?: Record<string, unknown>;
    registerService: (service: {
      id: string;
      start: () => Promise<void>;
      stop: () => Promise<void>;
    }) => void;
    registerTool: (
      tool: ToolDefinition | ((ctx: ToolContext) => ToolDefinition),
      opts?: { optional?: boolean },
    ) => void;
    on: (event: string, handler: (...args: unknown[]) => unknown) => void;
  };

  export function emptyPluginConfigSchema(): Record<string, unknown>;
}
