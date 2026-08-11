import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { ResidentControllerLocalServer } from "./local-server.js";

const controller = {
  async call() {
    return { ok: true };
  },
};

function sessionTemporaryDirectory(): Promise<string> {
  const sessionRoot = path.resolve(process.cwd(), "../../..");
  return fs.mkdtemp(path.join(sessionRoot, ".local-server-test-"));
}

test("local server removes a stale socket left by a crashed process", async () => {
  const directory = await sessionTemporaryDirectory();
  const socketPath = path.join(directory, "controller.sock");
  const child = spawn(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write("ready\\n"))`,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  await once(child.stdout!, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal((await fs.lstat(socketPath)).isSocket(), true);

  const server = new ResidentControllerLocalServer(controller, socketPath);
  await server.start();
  assert.equal((await fs.lstat(socketPath)).isSocket(), true);

  await server.stop();
  await fs.rmdir(directory);
});

test("local server refuses to replace a socket that accepts connections", async () => {
  const directory = await sessionTemporaryDirectory();
  const socketPath = path.join(directory, "controller.sock");
  const first = new ResidentControllerLocalServer(controller, socketPath);
  const second = new ResidentControllerLocalServer(controller, socketPath);
  await first.start();

  await assert.rejects(second.start(), { code: "EADDRINUSE" });
  const socket = net.createConnection(socketPath);
  await once(socket, "connect");
  socket.destroy();

  await first.stop();
  await fs.rmdir(directory);
});
