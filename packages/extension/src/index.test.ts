import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WebSocketServer } from "ws";

import {
  deliverSettledAnnotationIntentTurn,
  type SurfAceAnnotationIntentTurn,
  __test,
} from "./annotation-intent-delivery.js";
import {
  resolveSurfAceToolContextFromOpenClawContext,
  surfAceToolContextFromOpenClawContext,
} from "./openclaw-tool-context.js";
import { evaluateProviderHostGuard } from "./provider-host-guard.js";
import { SurfAceWireClient } from "./surf-ace-server.js";

test("Surf Ace extension does not inject static instructions through prompt-build hooks", () => {
  const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const instructionSource = readFileSync(new URL("./agent-instructions.ts", import.meta.url), "utf8");

  assert.equal(indexSource.includes("before_prompt_build"), false);
  assert.equal(instructionSource.includes("prependContext"), false);
  assert.equal(instructionSource.includes("prependSystemContext"), false);
});

test("Surf Ace plugin tool registration preserves OpenClaw session provenance", () => {
  assert.deepEqual(
    surfAceToolContextFromOpenClawContext({
      agentId: "agent-1",
      displayName: "Session One",
      pushedBy: {
        displayName: "Nested Agent",
        sessionKey: "agent:test:nested",
      },
      sessionDisplayName: "Session Display",
      sessionKey: "agent:test:session",
      streamLabel: "soak",
    }),
    {
      agentId: "agent-1",
      displayName: "Session One",
      provenance: undefined,
      pushedAt: undefined,
      pushedBy: {
        displayName: "Nested Agent",
        sessionKey: "agent:test:nested",
      },
      source: "openclaw-plugin",
      sourceProvenance: undefined,
      sessionDisplayName: "Session Display",
      sessionKey: "agent:test:session",
      streamLabel: "soak",
    },
  );
});

test("Surf Ace plugin tool context resolves Clawline chat display names from the chat DB", async () => {
  const sqliteCalls: string[][] = [];
  const resolved = await resolveSurfAceToolContextFromOpenClawContext(
    {
      sessionDisplayName: "Generic Tool Label",
      sessionKey: "agent:main:clawline:flynn:main",
    },
    {
      clawlineChatNames: {
        dbPath: "/tmp/clawline.sqlite",
        runSqlite: async (args) => {
          sqliteCalls.push(args);
          return "Personal\n";
        },
      },
    },
  );

  assert.equal(resolved.sessionKey, "agent:main:clawline:flynn:main");
  assert.equal(resolved.sessionDisplayName, "Personal");
  assert.deepEqual(sqliteCalls, [
    [
      "/tmp/clawline.sqlite",
      "SELECT displayName FROM stream_sessions WHERE sessionKey = 'agent:main:clawline:flynn:main' AND trim(displayName) <> '' ORDER BY updatedAt DESC LIMIT 1;",
    ],
  ]);
});

test("Surf Ace plugin tool context preserves raw session keys when Clawline chat lookup misses", async () => {
  const resolved = await resolveSurfAceToolContextFromOpenClawContext(
    {
      sessionKey: "agent:external:session",
    },
    {
      clawlineChatNames: {
        dbPath: "/tmp/clawline.sqlite",
        runSqlite: async () => "\n",
      },
    },
  );

  assert.equal(resolved.sessionKey, "agent:external:session");
  assert.equal(resolved.sessionDisplayName, undefined);
});

test("Surf Ace plugin tool context resolves Clawline names from nested source provenance keys", async () => {
  const sqliteCalls: string[][] = [];
  const resolved = await resolveSurfAceToolContextFromOpenClawContext(
    {
      sourceProvenance: {
        sessionKey: "agent:main:clawline:flynn:s_3d3b104a",
      },
    },
    {
      clawlineChatNames: {
        dbPath: "/tmp/clawline.sqlite",
        runSqlite: async (args) => {
          sqliteCalls.push(args);
          return "Surf Ace\n";
        },
      },
    },
  );

  assert.equal(resolved.sessionDisplayName, "Surf Ace");
  assert.equal(resolved.sourceProvenance?.sessionKey, "agent:main:clawline:flynn:s_3d3b104a");
  assert.match(sqliteCalls[0]?.[1] ?? "", /agent:main:clawline:flynn:s_3d3b104a/);
});

test("Surf Ace provider host guard allows TARS aliases", () => {
  assert.deepEqual(evaluateProviderHostGuard(["tars"], {}), {
    allowed: true,
    hostNames: ["tars"],
    reason: "tars_host",
  });
  assert.deepEqual(evaluateProviderHostGuard(["TARS.tail4105e8.ts.net."], {}), {
    allowed: true,
    hostNames: ["tars.tail4105e8.ts.net"],
    reason: "tars_host",
  });
  assert.deepEqual(evaluateProviderHostGuard(["tars.local"], {}), {
    allowed: true,
    hostNames: ["tars"],
    reason: "tars_host",
  });
  assert.deepEqual(evaluateProviderHostGuard(["TARS-2.local"], {}), {
    allowed: true,
    hostNames: ["tars-2"],
    reason: "tars_host",
  });
});

test("Surf Ace provider host guard rejects non-TARS hosts without override", () => {
  const result = evaluateProviderHostGuard(["eezo.local"], {});

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "non_tars_host");
  assert.deepEqual(result.hostNames, ["eezo"]);
  assert.match(result.message ?? "", /TARS-only/);
  assert.match(result.message ?? "", /SURF_ACE_ALLOW_NON_TARS_PROVIDER=1/);
});

test("Surf Ace provider host guard allows explicit non-TARS override", () => {
  assert.deepEqual(
    evaluateProviderHostGuard(["eezo.local"], {
      SURF_ACE_ALLOW_NON_TARS_PROVIDER: "1",
    }),
    {
      allowed: true,
      hostNames: ["eezo"],
      reason: "override",
    },
  );
});

test("Surf Ace wire client rejects inbound target.register as unsupported product surface", async () => {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test websocket server");
  }

  const responsePromise = new Promise<Record<string, any>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timed out waiting for target.register rejection"));
    }, 3000);
    server.once("connection", (socket) => {
      socket.on("message", (data) => {
        clearTimeout(timeout);
        resolve(JSON.parse(Buffer.from(data).toString("utf8")) as Record<string, any>);
      });
      socket.send(JSON.stringify({
        id: "req_register",
        op: "target.register",
        payload: {
          expectedPreviousTargetEpoch: null,
          idempotencyKey: "idem_1",
          launchedAt: new Date(0).toISOString(),
          ownershipEpoch: 1,
          ownershipSessionId: "sa_1",
          paneLineageId: "pl_1",
          registrationState: "attached",
          surfaceId: "sf_1",
          surfaceInstanceId: null,
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "navigate",
            requiredCapabilities: ["target.browser_url.v1"],
            safeToLogFields: ["url"],
            safetyClass: "network",
            summary: "https://example.com/",
          },
          targetKind: "browser_url",
          targetPayload: { url: "https://example.com/" },
        },
        sentAt: Date.now(),
        type: "request",
        v: 1,
      }));
    });
  });

  const client = new SurfAceWireClient(`ws://127.0.0.1:${address.port}`);
  try {
    await client.connect(1000);
    const response = await responsePromise;
    assert.equal(response.type, "response");
    assert.equal(response.ok, true);
    assert.equal(response.op, "target.register.rejected");
    assert.equal(response.payload?.status, "rejected");
    assert.equal(response.payload?.errorCode, "registration_failed");
    assert.match(String(response.payload?.message), /not supported by this product surface/);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

test("settled annotation delivery connects to the gateway and sends the image attachment via agent", async () => {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test websocket server");
  }

  const seenRequests: Array<{ method: string; params: unknown }> = [];
  const agentParamsPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timed out waiting for agent request"));
    }, 3000);

    server.once("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(Buffer.from(data).toString("utf8")) as {
          id: string;
          method: string;
          params?: unknown;
          type: string;
        };
        if (frame.type !== "req") {
          return;
        }
        seenRequests.push({ method: frame.method, params: frame.params });
        if (frame.method === "connect") {
          socket.send(
            JSON.stringify({
              id: frame.id,
              ok: true,
              payload: { type: "hello-ok" },
              type: "res",
            }),
          );
          return;
        }
        if (frame.method === "agent") {
          clearTimeout(timeout);
          socket.send(
            JSON.stringify({
              id: frame.id,
              ok: true,
              payload: { acceptedAt: Date.now(), runId: "run-1", status: "accepted" },
              type: "res",
            }),
          );
          resolve(frame.params as Record<string, unknown>);
        }
      });
    });
  });

  const turn: SurfAceAnnotationIntentTurn = {
    attachment: {
      content: "c3VyZi1hY2U=",
      fileName: "annotated-pane.png",
      mimeType: "image/png",
      type: "file",
    },
    fingerprint: "surface-1",
    frame: {
      contentId: "content-1",
      contextKey: "surface-1:1",
      frameId: "frame-1",
      image: "c3VyZi1hY2U=",
      openedAt: 1700000000000,
      scrollOffset: { x: 0, y: 0 },
      strokes: [],
      updatedAt: 1700000000010,
      viewport: {
        height: 768,
        scale: 2,
        visibleRect: { height: 768, width: 1024, x: 0, y: 0 },
        width: 1024,
      },
    },
    idempotencyKey: "surf-ace-annotation-intent:surface-1:1:frame-1",
    message: "Treat the attached image as the primary annotation input.",
    paneId: 1,
    sessionKey: "agent:test:annotate",
    surfaceName: "Surface A",
  };

  try {
    await deliverSettledAnnotationIntentTurn(
      {
        config: {
          loadConfig: () => ({
            gateway: {
              auth: {
                mode: "token",
                token: "config-token",
              },
              port: address.port,
            },
          }),
        },
      },
      turn,
    );

    const agentParams = await agentParamsPromise;
    assert.deepEqual(seenRequests.map((request) => request.method), ["connect", "agent"]);

    const connectParams = seenRequests[0]?.params as Record<string, unknown>;
    assert.deepEqual(connectParams.auth, { token: "config-token" });
    assert.equal(connectParams.role, "operator");
    assert.deepEqual(connectParams.scopes, ["operator.admin"]);

    assert.deepEqual(agentParams, {
      attachments: [turn.attachment],
      bestEffortDeliver: false,
      idempotencyKey: turn.idempotencyKey,
      message: turn.message,
      sessionKey: turn.sessionKey,
    });
  } finally {
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
});

test("gateway delivery config prefers env overrides for local token auth", () => {
  const previousUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousLegacyToken = process.env.CLAWDBOT_GATEWAY_TOKEN;

  try {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;

    assert.deepEqual(
      __test.resolveGatewayDeliveryConfig({
        config: {
          loadConfig: () => ({
            gateway: {
              auth: {
                mode: "token",
                token: "config-token",
              },
              port: 18789,
            },
          }),
        },
      }),
      {
        auth: { token: "env-token" },
        url: "ws://127.0.0.1:19999",
      },
    );
  } finally {
    if (previousUrl === undefined) {
      delete process.env.OPENCLAW_GATEWAY_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_URL = previousUrl;
    }
    if (previousToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
    }
    if (previousLegacyToken === undefined) {
      delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    } else {
      process.env.CLAWDBOT_GATEWAY_TOKEN = previousLegacyToken;
    }
  }
});
