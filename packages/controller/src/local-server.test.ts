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

test("local server responds after the client half-closes while a request is pending", async () => {
  const directory = await sessionTemporaryDirectory();
  const socketPath = path.join(directory, "controller.sock");
  let markCalled!: () => void;
  let release!: () => void;
  const called = new Promise<void>((resolve) => markCalled = resolve);
  const pending = new Promise<void>((resolve) => release = resolve);
  const server = new ResidentControllerLocalServer({
    async call() {
      markCalled();
      await pending;
      return { ok: true };
    },
  }, socketPath);
  await server.start();

  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let encoded = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.end(`${JSON.stringify({
        command: "list",
        id: "local_half_close",
        input: {},
        v: 1,
      })}\n`);
    });
    socket.on("data", (chunk) => encoded += chunk);
    socket.on("end", () => resolve(JSON.parse(encoded)));
    socket.on("error", reject);
  });

  await called;
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await response, {
    id: "local_half_close",
    ok: true,
    result: { ok: true },
    v: 1,
  });

  await server.stop();
  await fs.rmdir(directory);
});
