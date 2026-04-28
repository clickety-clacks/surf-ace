import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { isPortBoundOnIpv6Any } from "../src/port-selection.js";

async function listenIpv6Any(port: number): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "::", ipv6Only: true, port }, resolve);
  });
  return server;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test("port selection detects an IPv6-any listener that would alias Electron's IPv4 port", async () => {
  const reserved = await listenIpv6Any(0);
  const address = reserved.address();
  assert.ok(address && typeof address !== "string");

  try {
    assert.equal(await isPortBoundOnIpv6Any(address.port), true);
  } finally {
    await closeServer(reserved);
  }

  assert.equal(await isPortBoundOnIpv6Any(address.port), false);
});
