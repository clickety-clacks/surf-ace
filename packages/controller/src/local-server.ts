import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { ResidentController } from "./resident-controller.js";

type LocalRequest = {
  command: string;
  id: string;
  input: unknown;
  v: 1;
};

function request(value: unknown): LocalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_local_request");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.v !== 1 ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.command !== "string" ||
    candidate.command.length === 0
  ) {
    throw new Error("invalid_local_request");
  }
  return candidate as LocalRequest;
}

export class ResidentControllerLocalServer {
  private server: net.Server | null = null;

  constructor(
    private readonly controller: Pick<ResidentController, "call">,
    readonly socketPath: string,
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const encoded = buffer.slice(0, newline);
        buffer = "";
        void this.respond(socket, encoded);
      });
    });
    try {
      await listen(server, this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
      const candidate = await fs.lstat(this.socketPath);
      if (!candidate.isSocket() || await acceptsConnections(this.socketPath)) {
        throw error;
      }
      const current = await fs.lstat(this.socketPath);
      if (
        !current.isSocket() ||
        current.dev !== candidate.dev ||
        current.ino !== candidate.ino
      ) {
        throw error;
      }
      await fs.unlink(this.socketPath);
      await listen(server, this.socketPath);
    }
    await fs.chmod(this.socketPath, 0o600);
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async respond(socket: net.Socket, encoded: string): Promise<void> {
    let id: string | null = null;
    try {
      const parsed = request(JSON.parse(encoded) as unknown);
      id = parsed.id;
      const result = await this.controller.call(parsed.command, parsed.input);
      socket.end(`${JSON.stringify({ id, ok: true, result, v: 1 })}\n`);
    } catch (error) {
      socket.end(`${JSON.stringify({
        error: {
          code: "controller_request_failed",
          details: error instanceof Error ? error.message : String(error),
        },
        id,
        ok: false,
        v: 1,
      })}\n`);
    }
  }
}

function acceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}
