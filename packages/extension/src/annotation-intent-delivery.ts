import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";
import type { SurfAceAnnotationIntentTurn } from "./surf-ace-runtime.js";

const DEFAULT_GATEWAY_PORT = 18789;
const GATEWAY_OPEN_TIMEOUT_MS = 8000;
const GATEWAY_REQUEST_TIMEOUT_MS = 12000;

type GatewayConnectRequest = {
  auth?: {
    password?: string;
    token?: string;
  };
  client: {
    displayName: string;
    id: string;
    mode: "backend";
    platform: string;
    version: string;
  };
  role: "operator";
  scopes: string[];
};

type GatewayReqFrame = {
  id: string;
  method: string;
  params?: unknown;
  type: "req";
};

type GatewayResFrame = {
  error?: unknown;
  id: string;
  ok: boolean;
  payload?: unknown;
  type: "res";
};

type GatewayFrame =
  | GatewayResFrame
  | {
      type: string;
      [key: string]: unknown;
    };

type GatewayAuthMode = "none" | "password" | "token" | "trusted-proxy";

type GatewayConfigSnapshot = {
  gateway?: {
    auth?: {
      mode?: GatewayAuthMode;
      password?: string;
      token?: string;
    };
    port?: number;
    tls?: {
      enabled?: boolean;
    };
  };
};

type PluginRuntimeLike = {
  config?: {
    loadConfig?: () => unknown;
  };
};

export type GatewayDeliveryConfig = {
  auth?: {
    password?: string;
    token?: string;
  };
  url: string;
};

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveGatewayConfig(runtime: unknown): GatewayConfigSnapshot | undefined {
  const pluginRuntime = runtime as PluginRuntimeLike;
  if (typeof pluginRuntime?.config?.loadConfig !== "function") {
    return undefined;
  }
  return pluginRuntime.config.loadConfig() as GatewayConfigSnapshot;
}

function resolveGatewayUrl(config: GatewayConfigSnapshot | undefined): string {
  const envUrl =
    trimToUndefined(process.env.OPENCLAW_GATEWAY_URL) ??
    trimToUndefined(process.env.CLAWDBOT_GATEWAY_URL);
  if (envUrl) {
    return envUrl.includes("://") ? envUrl : `ws://${envUrl}`;
  }
  const tlsEnabled = config?.gateway?.tls?.enabled === true;
  const port =
    typeof config?.gateway?.port === "number" && Number.isFinite(config.gateway.port)
      ? config.gateway.port
      : DEFAULT_GATEWAY_PORT;
  return `${tlsEnabled ? "wss" : "ws"}://127.0.0.1:${port}`;
}

function resolveGatewayAuth(config: GatewayConfigSnapshot | undefined): GatewayDeliveryConfig["auth"] {
  const envToken =
    trimToUndefined(process.env.OPENCLAW_GATEWAY_TOKEN) ??
    trimToUndefined(process.env.CLAWDBOT_GATEWAY_TOKEN);
  const envPassword =
    trimToUndefined(process.env.OPENCLAW_GATEWAY_PASSWORD) ??
    trimToUndefined(process.env.CLAWDBOT_GATEWAY_PASSWORD);
  const configToken = trimToUndefined(config?.gateway?.auth?.token);
  const configPassword = trimToUndefined(config?.gateway?.auth?.password);
  const authMode = config?.gateway?.auth?.mode;

  if (authMode === "none" || authMode === "trusted-proxy") {
    return undefined;
  }
  if (authMode === "password") {
    const password = envPassword ?? configPassword;
    return password ? { password } : undefined;
  }
  if (authMode === "token") {
    const token = envToken ?? configToken;
    return token ? { token } : undefined;
  }
  const token = envToken ?? configToken;
  if (token) {
    return { token };
  }
  const password = envPassword ?? configPassword;
  return password ? { password } : undefined;
}

export function resolveGatewayDeliveryConfig(runtime: unknown): GatewayDeliveryConfig {
  const config = resolveGatewayConfig(runtime);
  return {
    auth: resolveGatewayAuth(config),
    url: resolveGatewayUrl(config),
  };
}

function rawDataToText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

export async function connectGatewaySession(
  config: GatewayDeliveryConfig,
): Promise<{
  close: () => void;
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<GatewayResFrame>;
}> {
  const ws = new WebSocket(config.url, {
    handshakeTimeout: GATEWAY_OPEN_TIMEOUT_MS,
  });
  const pending = new Map<
    string,
    {
      reject: (error: Error) => void;
      resolve: (response: GatewayResFrame) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  const settleAllPending = (error: Error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    pending.clear();
  };

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timed out opening gateway websocket"));
    }, GATEWAY_OPEN_TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  ws.on("message", (data) => {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(rawDataToText(data)) as GatewayFrame;
    } catch {
      return;
    }
    if (frame.type !== "res") {
      return;
    }
    const response = frame as GatewayResFrame;
    const waiter = pending.get(response.id);
    if (!waiter) {
      return;
    }
    pending.delete(response.id);
    clearTimeout(waiter.timeout);
    waiter.resolve(response);
  });
  ws.on("close", () => {
    settleAllPending(new Error("gateway websocket closed before response"));
  });
  ws.on("error", (error) => {
    settleAllPending(error instanceof Error ? error : new Error(String(error)));
  });

  const request = async (
    method: string,
    params?: unknown,
    timeoutMs = GATEWAY_REQUEST_TIMEOUT_MS,
  ): Promise<GatewayResFrame> =>
    await new Promise<GatewayResFrame>((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for gateway ${method} response`));
      }, timeoutMs);
      pending.set(id, { reject, resolve, timeout });
      const frame: GatewayReqFrame = { id, method, params, type: "req" };
      try {
        ws.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  const connectRequest: GatewayConnectRequest = {
    client: {
      displayName: "Surf Ace",
      id: "gateway-client",
      mode: "backend",
      platform: "node",
      version: "0.1.0",
    },
    role: "operator",
    scopes: ["operator.admin"],
  };
  if (config.auth?.token || config.auth?.password) {
    connectRequest.auth = config.auth;
  }
  const connectResponse = await request("connect", connectRequest);
  if (!connectResponse.ok) {
    ws.close();
    throw new Error(
      `gateway connect failed: ${
        connectResponse.error instanceof Error
          ? connectResponse.error.message
          : JSON.stringify(connectResponse.error)
      }`,
    );
  }

  return {
    close: () => {
      ws.close();
    },
    request,
  };
}

export async function deliverSettledAnnotationIntentTurn(
  runtime: unknown,
  turn: SurfAceAnnotationIntentTurn,
): Promise<void> {
  const config = resolveGatewayDeliveryConfig(runtime);
  const session = await connectGatewaySession(config);
  try {
    const response = await session.request("agent", {
      attachments: [turn.attachment],
      bestEffortDeliver: false,
      idempotencyKey: turn.idempotencyKey,
      message: turn.message,
      sessionKey: turn.sessionKey,
    });
    if (!response.ok) {
      throw new Error(
        `gateway agent failed: ${
          response.error instanceof Error ? response.error.message : JSON.stringify(response.error)
        }`,
      );
    }
  } finally {
    session.close();
  }
}

export const __test = {
  connectGatewaySession,
  resolveGatewayDeliveryConfig,
};
