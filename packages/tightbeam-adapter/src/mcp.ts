import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import {
  TightBeamSurfAceAdapter,
  type TightBeamAdapterTool,
} from "./adapter.js";
import { tightBeamSurfAceTools } from "./tools.js";

type JsonRpcRequest = {
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export async function runMcpServer(
  adapter: TightBeamSurfAceAdapter,
  io: {
    input?: Readable;
    write?: (value: unknown) => void;
  } = {},
): Promise<void> {
  const write = io.write ?? ((value: unknown) => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  });
  await adapter.start();
  const lines = createInterface({
    input: io.input ?? process.stdin,
    terminal: false,
  });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        write({
          error: { code: -32700, message: "Parse error" },
          id: null,
          jsonrpc: "2.0",
        });
        continue;
      }
      const notification = !Object.prototype.hasOwnProperty.call(
        request,
        "id",
      );
      try {
        const response = await handleRequest(adapter, request);
        if (!notification) {
          write(response);
        }
      } catch (error) {
        if (!notification) {
          const rpcError = error instanceof JsonRpcError ? error : null;
          write({
            error: {
              code: rpcError?.code ?? -32000,
              message: rpcError?.message ?? String(error),
            },
            id: request.id ?? null,
            jsonrpc: "2.0",
          });
        }
      }
    }
  } finally {
    await adapter.stop();
  }
}

class JsonRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export async function handleRequest(
  adapter: TightBeamSurfAceAdapter,
  request: JsonRpcRequest,
): Promise<unknown> {
  if (request.method === "initialize") {
    return {
      id: request.id ?? null,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: {} },
        protocolVersion: "2025-06-18",
        serverInfo: {
          name: "tightbeam-surf-ace",
          version: "0.1.0",
        },
      },
    };
  }
  if (request.method === "notifications/initialized") {
    return null;
  }
  if (request.method === "shutdown") {
    return {
      id: request.id ?? null,
      jsonrpc: "2.0",
      result: null,
    };
  }
  if (request.method === "tools/list") {
    return {
      id: request.id ?? null,
      jsonrpc: "2.0",
      result: { tools: tightBeamSurfAceTools },
    };
  }
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (typeof name !== "string") {
      throw new Error("tools/call requires a tool name");
    }
    const result = await adapter.call(
      name as TightBeamAdapterTool,
      request.params?.arguments ?? {},
    );
    return {
      id: request.id ?? null,
      jsonrpc: "2.0",
      result: {
        content: [{
          text: JSON.stringify(result),
          type: "text",
        }],
      },
    };
  }
  throw new JsonRpcError(-32601, `Method not found: ${request.method}`);
}
