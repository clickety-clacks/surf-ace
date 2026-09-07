import assert from "node:assert/strict";
import test from "node:test";
import { ServerConnection } from "../src/server-connection.js";
import { ConfiguredServerRegistration } from "../src/configured-server.js";
import { SurfaceCore } from "../src/surface-core.js";

test("Bonjour transport fallback is limited to hostname resolution failures", async () => {
  const original = ConfiguredServerRegistration.prototype.synchronize;
  const originalStop = ConfiguredServerRegistration.prototype.stop;
  try {
    for (const code of [undefined, "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "registration_failed"]) {
      const attempted: string[] = [];
      ConfiguredServerRegistration.prototype.synchronize = async function () {
        const url = (this as any).wire.url as string;
        attempted.push(url);
        if (url.includes("stable.local") && code) throw Object.assign(new Error(code), { code });
      };
      ConfiguredServerRegistration.prototype.stop = async () => {};
      const endpoint = {
        host: "stable.local", endpointId: "stable.local:19430/#stable", port: 19430,
        wsPath: "/", role: "server", transportAddresses: ["192.0.2.10"],
      } as any;
      const connection = new ServerConnection({
        clientId: "fixture", core: new SurfaceCore(), persist: async () => {},
        discovery: {
          start: async () => {}, stop: async () => {}, refreshNow: async () => {},
          subscribe: () => () => {}, getSnapshot: () => [endpoint],
        },
      });
      if (code === "ECONNREFUSED" || code === "registration_failed") {
        await assert.rejects(connection.synchronize(), /no_surf_ace_server/);
      } else {
        await connection.synchronize();
      }
      assert.deepEqual(attempted, code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? ["ws://stable.local:19430/", "ws://192.0.2.10:19430/"]
        : ["ws://stable.local:19430/"]);
      assert.equal(endpoint.host, "stable.local");
      assert.equal(endpoint.endpointId, "stable.local:19430/#stable");
      await connection.stop();
    }
  } finally {
    ConfiguredServerRegistration.prototype.synchronize = original;
    ConfiguredServerRegistration.prototype.stop = originalStop;
  }
});
