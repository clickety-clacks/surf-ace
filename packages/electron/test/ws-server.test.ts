import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import WebSocket from "ws";

import type { PairRequest, Request, Response } from "../../protocol/src/index.js";
import { SurfaceCore } from "../src/surface-core.js";
import { SurfaceWsServer, __test } from "../src/ws-server.js";

let nextPort = 24301;

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

async function closeSocket(socket: WebSocket, code = 1000, reason = "test_done"): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.close(code, reason);
  });
}

async function request(socket: WebSocket, payload: Request): Promise<Response> {
  const response = new Promise<Response>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(String(data)) as Response | { id?: string; type?: string };
        if (message.type !== "response" || message.id !== payload.id) {
          return;
        }
        cleanup();
        resolve(message as Response);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`socket closed before response ${payload.id}`));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
  socket.send(JSON.stringify(payload));
  return await response;
}

async function collectEvents(
  socket: WebSocket,
  count: number,
  acceptedOps: string[],
): Promise<Array<{ op: string; payload: Record<string, unknown> }>> {
  return await new Promise((resolve, reject) => {
    const events: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(String(data)) as {
          op?: string;
          payload?: Record<string, unknown>;
          type?: string;
        };
        if (message.type !== "event" || !message.op || !acceptedOps.includes(message.op)) {
          return;
        }
        events.push({ op: message.op, payload: message.payload ?? {} });
        if (events.length >= count) {
          cleanup();
          resolve(events);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before expected events"));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function surfacesListRequest(): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "surfaces.list",
    payload: {},
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function pairRequest(
  surfaceId: string,
  providerId: string,
  options: {
    providerName?: string | null;
    resumeSessionId?: string;
    takeover?: boolean;
  } = {},
): PairRequest {
  const payload: PairRequest["payload"] = {
    connectionId: `conn_${Math.random().toString(16).slice(2)}` as never,
    initialPaneId: 1 as never,
    initialPaneLabel: 1,
    protocolVersion: 1,
    providerId: providerId as never,
    providerName: options.providerName ?? "test-harness",
    resume: options.resumeSessionId
      ? { sessionId: options.resumeSessionId as never }
      : undefined,
    surfaceId: surfaceId as never,
    takeover: options.takeover ?? false,
    windowLabel: "a",
  };
  if (options.providerName === null) {
    delete (payload as { providerName?: string }).providerName;
  }
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "pair.request",
    payload,
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function relinquishRequest(): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "ownership.relinquish",
    payload: {},
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function contentSetRequest(paneId: number, revision = 1): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "content.set",
    payload: {
      content: { html: "<p>annotate</p>" },
      contentId: "ct_snapshot" as never,
      contentType: "html",
      historyOwnerToken: "hot_snapshot" as never,
      paneId: paneId as never,
      revision: revision as never,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function contentClearRequest(paneId: number, revision: number): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "content.clear",
    payload: {
      paneId: paneId as never,
      revision: revision as never,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function topologyApplyRequest(): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "topology.apply",
    payload: {
      layout: {
        children: [
          { paneId: 1 as never, type: "pane" },
          { paneId: 2 as never, type: "pane" },
        ],
        direction: "horizontal",
        type: "split",
      },
      panes: [
        { name: "Left", paneId: 1 as never, paneLabel: 41 },
        { name: "Right", paneId: 2 as never, paneLabel: 42 },
      ],
      topologyRevision: 7 as never,
      windowLabel: "b",
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function contentApplyRequest(paneId: number, revision: number): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "content.apply",
    payload: {
      content: { markdown: "# Applied" },
      contentId: "ct_applied" as never,
      contentType: "markdown",
      historyOwnerToken: "hot_apply",
      paneId: paneId as never,
      revision: revision as never,
      topologyRevision: 7 as never,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function targetApplyRequest(
  overrides: Partial<{
    ownershipSessionId: string;
    paneLineageId: string;
    surfaceId: string;
  }> = {},
): Request {
  const surfaceId = overrides.surfaceId ?? "sf_test";
  const paneLineageId = overrides.paneLineageId ?? "pl_118";
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "target.apply",
    payload: {
      ownershipEpoch: 1,
      ownershipSessionId: overrides.ownershipSessionId ?? "sa_test",
      paneLineageId,
      restoreReason: "resume_restore",
      requestId: "restore_top_118",
      surfaceId: surfaceId as never,
      targetEpoch: 3,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "launch_equivalent",
        requiredCapabilities: ["target.terminal_app.v1"],
        safeToLogFields: [],
        safetyClass: "process",
        summary: "top",
      },
      targetId: "target_top_118",
      targetKind: "terminal_app",
      targetPayload: { args: ["top"], command: "foot" },
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function browserUrlTargetApplyRequest(
  options: {
    ownershipSessionId: string;
    paneLineageId: string;
    surfaceId: string;
    targetId?: string;
    url?: string;
  },
): Request {
  const targetUrl = options.url ?? "https://example.com/";
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "target.apply",
    payload: {
      ownershipEpoch: 1,
      ownershipSessionId: options.ownershipSessionId as never,
      paneLineageId: options.paneLineageId as never,
      restoreReason: "initial_apply",
      requestId: "restore_url",
      surfaceId: options.surfaceId as never,
      targetEpoch: 3,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: targetUrl,
      },
      targetId: options.targetId ?? "target_url",
      targetKind: "browser_url",
      targetPayload: { url: targetUrl },
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function paneSplitRequest(
  paneId: number,
  options: {
    count?: number;
    direction?: "horizontal" | "vertical";
    newPaneIds?: number[];
    newPaneLabels?: number[];
  } = {},
): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "pane.split",
    payload: {
      count: options.count ?? 2,
      direction: options.direction ?? "horizontal",
      newPaneIds: (options.newPaneIds ?? [2]).map((value) => value as never),
      newPaneLabels: options.newPaneLabels ?? [2],
      paneId: paneId as never,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function snapshotGetRequest(paneId: number): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "snapshot.get",
    payload: {
      includeDrawings: true,
      includeImage: false,
      includeVisibleText: true,
      paneId: paneId as never,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function heartbeatRequest(): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "heartbeat.ping",
    payload: {
      nonce: `hb_${Math.random().toString(16).slice(2)}`,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function overlayDiagnosticsRequest(): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "diagnostics.overlay_regions" as never,
    payload: {},
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

async function withServer(
  run: (ctx: { core: SurfaceCore; surfaceId: string; url: string; server: SurfaceWsServer }) => Promise<void>,
  options: {
    compositorSocketPath?: string | null;
    getOverlayDiagnostics?: (surfaceId: string) => Record<string, unknown> | null;
    onNativeMaterialized?: (surfaceId: string) => void;
  } = {},
): Promise<void> {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    core,
    endpointName: "Surf Ace",
    getOverlayDiagnostics: options.getOverlayDiagnostics,
    hostName: "localhost",
    compositorSocketPath: options.compositorSocketPath ?? null,
    onNativeMaterialized: options.onNativeMaterialized,
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });

  await server.start();
  try {
    await run({
      core,
      server,
      surfaceId: surface.surfaceId,
      url: `ws://127.0.0.1:${port}${server.wsPath}`,
    });
  } finally {
    await server.stop();
  }
}

test("ws server keeps ownership lock after owner socket closes", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const probe = await connect(url);
    const listed = await request(probe, surfacesListRequest());
    assert.equal(listed.ok, true);
    assert.equal(listed.op, "surfaces.list");
    assert.equal(listed.payload.surfaces[0]?.paired, true);
    await closeSocket(probe);
  });
});

test("ws server diagnostics format concise structured fields", () => {
  assert.equal(
    __test.serverDiagnostic("pair_request_begin", {
      provider_id: "pv_alpha",
      surface_id: "sf_main",
      takeover: false,
    }),
    "[surf-ace:server] event=pair_request_begin provider_id=pv_alpha surface_id=sf_main takeover=false",
  );
});

test("ws server allows the lock owner to resume after disconnect", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const resumedSocket = await connect(url);
    const resumed = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", { resumeSessionId: first.payload.sessionId }),
    );

    assert.equal(resumed.ok, true);
    assert.equal(resumed.op, "pair.request");
    assert.equal(resumed.payload.resumed, true);
    assert.equal(resumed.payload.sessionId, first.payload.sessionId);

    await closeSocket(resumedSocket);
  });
});

test("ws server rejects owner reconnect with an invalid resume token", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const resumedSocket = await connect(url);
    const invalid = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", { resumeSessionId: `sa_invalid` as never }),
    );

    assert.equal(invalid.ok, false);
    assert.equal(invalid.op, "pair.request");
    assert.equal(invalid.error.code, "invalid_resume");

    await closeSocket(resumedSocket);
  });
});

test("ws server rejects same-provider reconnects without a resume token after disconnect", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const replacement = await connect(url);
    const resumed = await request(
      replacement,
      pairRequest(surfaceId, "pv_alpha"),
    );

    assert.equal(resumed.ok, false);
    assert.equal(resumed.op, "pair.request");
    assert.equal(resumed.error.code, "invalid_resume");

    await closeSocket(replacement);
  });
});

test("ws server allows explicit same-provider takeover of a disconnected stale lock", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const replacement = await connect(url);
    const reclaimed = await request(
      replacement,
      pairRequest(surfaceId, "pv_alpha", { takeover: true }),
    );

    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.op, "pair.request");
    assert.equal(reclaimed.payload.resumed, false);
    assert.notEqual(reclaimed.payload.sessionId, first.payload.sessionId);

    await closeSocket(replacement);
  });
});

test("ws server rejects duplicate same-provider pair requests while the active socket is still open", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);

    const duplicate = await connect(url);
    const rejected = await request(duplicate, pairRequest(surfaceId, "pv_alpha"));

    assert.equal(rejected.ok, false);
    assert.equal(rejected.op, "pair.request");
    assert.equal(rejected.error.code, "busy");
    assert.equal(owner.readyState, WebSocket.OPEN);

    const takeoverRejected = await request(duplicate, pairRequest(surfaceId, "pv_alpha", { takeover: true }));
    assert.equal(takeoverRejected.ok, false);
    assert.equal(takeoverRejected.op, "pair.request");
    assert.equal(takeoverRejected.error.code, "busy");
    assert.equal(owner.readyState, WebSocket.OPEN);

    const panes = await request(owner, {
      id: `rq_${Math.random().toString(16).slice(2)}` as never,
      op: "panes.list",
      payload: {},
      sentAt: Date.now() as never,
      type: "request",
      v: 1,
    });
    assert.equal(panes.ok, true);
    assert.equal(panes.op, "panes.list");

    await closeSocket(duplicate);
    await closeSocket(owner);
  });
});

test("ws server rejects foreign providers without takeover while locked", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const foreign = await connect(url);
    const busy = await request(foreign, pairRequest(surfaceId, "pv_bravo"));

    assert.equal(busy.ok, false);
    assert.equal(busy.op, "pair.request");
    assert.equal(busy.error.code, "busy");

    await closeSocket(foreign);
  });
});

test("ws server accepts explicit takeover from a different provider while locked", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const takeover = await connect(url);
    const second = await request(
      takeover,
      pairRequest(surfaceId, "pv_bravo", { takeover: true }),
    );

    assert.equal(second.ok, true);
    assert.equal(second.op, "pair.request");
    assert.equal(second.payload.resumed, false);
    assert.notEqual(second.payload.sessionId, first.payload.sessionId);

    await closeSocket(takeover);
  });
});

test("ws server clears the ownership lock on ownership.relinquish", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);

    const relinquished = await request(owner, relinquishRequest());
    assert.equal(relinquished.ok, true);
    assert.equal(relinquished.op, "ownership.relinquish");
    assert.equal(relinquished.payload.relinquished, true);

    await new Promise((resolve) => {
      owner.once("close", () => resolve(undefined));
    });

    const probe = await connect(url);
    const listed = await request(probe, surfacesListRequest());
    assert.equal(listed.ok, true);
    assert.equal(listed.payload.surfaces[0]?.paired, false);
    await closeSocket(probe);
  });
});

test("ws server exposes providerName while connected and clears it on relinquish", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha", { providerName: "CLU / Surf Ace" }));
    assert.equal(paired.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connecting");
    assert.equal(core.getRendererWindowState(surfaceId).providerName, "CLU / Surf Ace");

    const heartbeat = await request(owner, heartbeatRequest());
    assert.equal(heartbeat.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connected");

    const relinquished = await request(owner, relinquishRequest());
    assert.equal(relinquished.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).providerName, null);

    await closeSocket(owner);
  });
});

test("ws server does not show green until provider heartbeat confirms readiness", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connecting");

    const heartbeat = await request(owner, heartbeatRequest());
    assert.equal(heartbeat.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connected");

    await closeSocket(owner);
  });
});

test("ws server rejects pair requests without providerName", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    const rejected = await request(socket, pairRequest(surfaceId, "pv_alpha", { providerName: null }));

    assert.equal(rejected.ok, false);
    assert.equal(rejected.op, "pair.request");
    assert.equal(rejected.error.code, "missing_provider_name");

    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
  });
});

test("ws server advertises terminal targets when compositor bridge is configured", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));

    assert.equal(paired.ok, true);
    assert.deepEqual(paired.payload.capabilities.targetCapabilities, ["target.browser_url.v1", "target.terminal_app.v1"]);

    await closeSocket(socket);
  }, { compositorSocketPath: "/tmp/surf-ace-compositor-test.sock" });
});

test("ws server returns browser_url applied only after renderer load confirmation", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    assert.deepEqual(paired.payload.capabilities.targetCapabilities, ["target.browser_url.v1"]);

    const apply = browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_example",
      url: "https://example.com/",
    });
    const responsePromise = request(owner, apply);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentType, "browser_url");

    server.resolveBrowserUrlNavigation(surfaceId, Number(paired.payload.state.panes[0]!.paneId), {
      status: "applied",
      targetId: "target_example",
      url: "https://example.com/",
    });

    const response = await responsePromise;
    assert.equal(response.ok, true);
    assert.equal(response.op, "target.apply.result");
    assert.equal(response.payload.status, "applied");
    assert.equal(response.payload.materializedState?.navigationStatus, "loaded");
    assert.equal(core.captureSnapshot(surfaceId, Number(paired.payload.state.panes[0]!.paneId)).contentType, null);
    await closeSocket(owner);
  });
});

test("ws server releases a native-hosted pane before browser_url replacement", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, server, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      const browserApply = browserUrlTargetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
        targetId: "target_replacement",
        url: "https://example.com/replacement",
      });
      const responsePromise = request(owner, browserApply);
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "native_pane.release",
      ]);
      assert.deepEqual(received[3], {
        pane_ids: [String(paired.payload.state.panes[0]!.paneId)],
        type: "native_pane.release",
      });
      const pane = core.getRendererWindowState(surfaceId).panes[0]!;
      assert.equal(pane.externalNative, false);
      assert.equal(pane.content.contentType, "browser_url");

      server.resolveBrowserUrlNavigation(surfaceId, Number(paired.payload.state.panes[0]!.paneId), {
        status: "applied",
        targetId: "target_replacement",
        url: "https://example.com/replacement",
      });

      const response = await responsePromise;
      assert.equal(response.payload.status, "applied");
      assert.equal(response.payload.materializedState?.navigationStatus, "loaded");
      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server preserves native-hosted pane when browser_url release fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status" || message.type === "native_pane.host" || message.type === "overlay_regions.set") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ error: "release denied", ok: false })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");

      const rejected = await request(owner, browserUrlTargetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(rejected.payload.status, "rejected");
      assert.equal(rejected.payload.errorCode, "materialization_failed");
      assert.equal(rejected.payload.message, "release denied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentType, null);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "native_pane.release",
      ]);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server does not release native-hosted pane for invalid browser_url payloads", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");

      const rejected = await request(owner, browserUrlTargetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
        url: "file:///tmp/not-allowed.html",
      }));

      assert.equal(rejected.payload.status, "rejected");
      assert.equal(rejected.payload.errorCode, "unsafe_payload");
      assert.equal(rejected.payload.message, "browser_url targetPayload.url must be http or https");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentType, null);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server returns browser_url failed when renderer reports blocked navigation", async () => {
  await withServer(async ({ server, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const responsePromise = request(owner, browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_blocked",
      url: "https://example.com/blocked",
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    server.resolveBrowserUrlNavigation(surfaceId, Number(paired.payload.state.panes[0]!.paneId), {
      errorMessage: "webview navigation failed: blocked",
      status: "failed",
      targetId: "target_blocked",
      url: "https://example.com/blocked",
    });

    const response = await responsePromise;
    assert.equal(response.ok, true);
    assert.equal(response.op, "target.apply.result");
    assert.equal(response.payload.status, "failed");
    assert.equal(response.payload.errorCode, "materialization_failed");
    assert.equal(response.payload.materializedState?.navigationStatus, "failed");
    await closeSocket(owner);
  });
});

test("ws server fails an earlier browser_url apply when a later URL supersedes it", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    const pane = paired.payload.state.panes[0]!;

    const firstResponsePromise = request(owner, browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: pane.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_first",
      url: "https://first.example/",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondResponsePromise = request(owner, browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: pane.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_second",
      url: "https://second.example/",
    }));
    const firstResponse = await firstResponsePromise;
    assert.equal(firstResponse.ok, true);
    assert.equal(firstResponse.op, "target.apply.result");
    assert.equal(firstResponse.payload.status, "failed");
    assert.equal(firstResponse.payload.errorCode, "materialization_failed");
    assert.equal(firstResponse.payload.message, "browser_url navigation superseded before verification");

    server.resolveBrowserUrlNavigation(surfaceId, Number(pane.paneId), {
      status: "applied",
      targetId: "target_first",
      url: "https://first.example/",
    });
    assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentId, "target_second");

    server.resolveBrowserUrlNavigation(surfaceId, Number(pane.paneId), {
      status: "applied",
      targetId: "target_second",
      url: "https://second.example/",
    });
    const secondResponse = await secondResponsePromise;
    assert.equal(secondResponse.ok, true);
    assert.equal(secondResponse.op, "target.apply.result");
    assert.equal(secondResponse.payload.status, "applied");
    assert.equal(secondResponse.payload.materializedState?.navigationStatus, "loaded");
    await closeSocket(owner);
  });
});

test("ws server rejects stale browser_url load evidence after pane content changes", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    const pane = paired.payload.state.panes[0]!;

    const responsePromise = request(owner, browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: pane.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_stale",
      url: "https://stale.example/",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replaced = await request(owner, contentSetRequest(Number(pane.paneId), 4));
    assert.equal(replaced.ok, true);

    server.resolveBrowserUrlNavigation(surfaceId, Number(pane.paneId), {
      status: "applied",
      targetId: "target_stale",
      url: "https://stale.example/",
    });

    const response = await responsePromise;
    assert.equal(response.ok, true);
    assert.equal(response.op, "target.apply.result");
    assert.equal(response.payload.status, "failed");
    assert.equal(response.payload.errorCode, "materialization_failed");
    assert.equal(response.payload.message, "browser_url navigation was superseded before verification");
    assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentType, "html");
    await closeSocket(owner);
  });
});

test("ws server exposes renderer overlay forwarding diagnostics to the paired owner", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const diagnostics = await request(socket, overlayDiagnosticsRequest());
    assert.equal(diagnostics.ok, true);
    assert.equal(diagnostics.op, "diagnostics.overlay_regions");
    assert.deepEqual((diagnostics as never as { payload: unknown }).payload, {
      diagnostics: { forwardStatus: "ok", regionCount: 6 },
      surfaceId,
    });

    await closeSocket(socket);
  }, {
    getOverlayDiagnostics: (surfaceId) => ({ forwardStatus: "ok", regionCount: surfaceId ? 6 : 0 }),
  });
});

test("ws server derives target.apply native pane host materialization for compositor", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      const message = JSON.parse(line) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
            physical_output_height: 2160,
            physical_output_width: 3840,
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true, status: { panes: [{ id: "1" }] } })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    const nativeMaterializedSurfaces: string[] = [];
    await withServer(async ({ surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const applyRequest = targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      });
      assert.equal("materialization" in applyRequest.payload, false);

      const applied = await request(socket, applyRequest);

      assert.equal(applied.ok, true);
      assert.equal(applied.op, "target.apply.result");
      assert.equal(applied.payload.status, "applied");
      assert.deepEqual(received[0], { type: "get_status" });
      assert.equal((received[1] as { type: string }).type, "native_pane.host");
      const hostPane = (received[1] as { panes: Array<Record<string, unknown>> }).panes[0]!;
      assert.deepEqual(hostPane, {
        binding_id: "1:target_top_118",
        content_id: "target_top_118",
        geometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: 2,
          height: 800,
          paneInstanceId: hostPane.geometry && (hostPane.geometry as Record<string, unknown>).paneInstanceId,
          surfaceEpoch: `${surfaceId}:1`,
          topologyEpoch: 0,
          width: 1200,
          x: 0,
          y: 0,
        },
        id: "1",
        process: { args: ["top"], command: "foot" },
        revision: 3,
        target: "terminal",
      });
      assert.match(String((hostPane.geometry as Record<string, unknown>).paneInstanceId), /^pl_/);
      assert.deepEqual(applied.payload.materializedState?.preflightStatus, {
        ok: true,
        status: {
          logical_surface_height: 3840,
          logical_surface_width: 2160,
          pane_geometry_coordinate_space: "compositor_logical",
          physical_output_height: 2160,
          physical_output_width: 3840,
        },
      });
      assert.deepEqual(applied.payload.materializedState?.preflightStatusSummary, {
        nativeMaterializedPaneCount: null,
        topologyPaneCount: null,
        topologyPaneSource: "surf_ace_pair_or_panes_list",
      });
      assert.deepEqual(applied.payload.materializedState?.hostRequest, received[1]);
      assert.deepEqual(applied.payload.materializedState?.hostResponse, {
        ok: true,
        status: { panes: [{ id: "1" }] },
      });
      assert.deepEqual(nativeMaterializedSurfaces, [surfaceId]);

      await closeSocket(socket);
    }, {
      compositorSocketPath: socketPath,
      onNativeMaterialized: (surfaceId) => nativeMaterializedSurfaces.push(surfaceId),
    });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server derives target.apply native pane geometry from resolved topology snapshot", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      socket.write(`${JSON.stringify(message.type === "get_status"
        ? {
            ok: true,
            status: {
              logical_surface_height: 800,
              logical_surface_width: 1200,
              pane_geometry_coordinate_space: "compositor_logical",
            },
          }
        : { ok: true })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const topology = await request(socket, topologyApplyRequest());
      assert.equal(topology.ok, true);
      const paneLineageId = topology.payload.panes.find((pane) => Number(pane.paneId) === 1)?.paneLineageId;
      assert.ok(paneLineageId);

      const applyRequest = targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId,
        surfaceId: paired.payload.surfaceId,
      });
      assert.equal("materialization" in applyRequest.payload, false);

      const applied = await request(socket, applyRequest);

      assert.equal(applied.ok, true);
      assert.equal(applied.op, "target.apply.result");
      assert.equal(applied.payload.status, "applied");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);
      const hostPane = (received[1] as { panes: Array<Record<string, unknown>> }).panes[0]!;
      assert.deepEqual(hostPane.geometry, {
        coordinateSpace: "compositor_logical",
        geometryRevision: 3,
        height: 400,
        paneInstanceId: paneLineageId,
        surfaceEpoch: `${surfaceId}:1`,
        topologyEpoch: 7,
        width: 1200,
        x: 0,
        y: 0,
      });
      assert.equal(hostPane.id, "1");
      assert.equal(hostPane.binding_id, "1:target_top_118");

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server derives target.apply native pane identity from pane lineage", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const message = JSON.parse(String(chunk).trim()) as Record<string, unknown>;
      received.push(message);
      socket.write(`${JSON.stringify(message.type === "get_status"
        ? {
            ok: true,
            status: {
              logical_surface_height: 800,
              logical_surface_width: 1200,
              pane_geometry_coordinate_space: "compositor_logical",
            },
          }
        : { ok: true })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const topology = await request(socket, topologyApplyRequest());
      assert.equal(topology.ok, true);
      const secondPaneLineageId = topology.payload.panes.find((pane) => Number(pane.paneId) === 2)?.paneLineageId;
      assert.ok(secondPaneLineageId);

      const applied = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: secondPaneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(applied.ok, true);
      assert.equal(applied.op, "target.apply.result");
      assert.equal(applied.payload.status, "applied");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);
      const hostPane = (received[1] as { panes: Array<Record<string, unknown>> }).panes[0]!;
      assert.equal(hostPane.id, "2");
      assert.equal(hostPane.binding_id, "2:target_top_118");
      assert.deepEqual(hostPane.geometry, {
        coordinateSpace: "compositor_logical",
        geometryRevision: 3,
        height: 400,
        paneInstanceId: secondPaneLineageId,
        surfaceEpoch: `${surfaceId}:1`,
        topologyEpoch: 7,
        width: 1200,
        x: 0,
        y: 400,
      });

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rejects stale target.apply lineage before compositor materialization", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const rejected = await request(socket, targetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: "pl_stale",
      surfaceId: paired.payload.surfaceId,
    }));

    assert.equal(rejected.ok, true);
    assert.equal(rejected.op, "target.apply.result");
    assert.equal(rejected.payload.status, "rejected");
    assert.equal(rejected.payload.errorCode, "pane_lineage_missing");

    await closeSocket(socket);
  }, { compositorSocketPath: "/tmp/surf-ace-compositor-test.sock" });
});

test("ws server reports compositor target.apply rejection as materialization failure", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, unknown>;
      received.push(message);
      socket.write(`${JSON.stringify(message.type === "get_status"
        ? {
            ok: true,
            status: {
              logical_surface_height: 3840,
              logical_surface_width: 2160,
              pane_geometry_coordinate_space: "compositor_logical",
            },
          }
        : { error: { message: "invalid pane 1" }, ok: false })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const failed = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(failed.ok, true);
      assert.equal(failed.op, "target.apply.result");
      assert.equal(failed.payload.status, "failed");
      assert.equal(failed.payload.errorCode, "materialization_failed");
      assert.equal(failed.payload.message, "invalid pane 1");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), ["get_status", "native_pane.host"]);

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rejects target.apply geometry outside compositor logical status bounds", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, unknown>;
      received.push(message);
      socket.write(`${JSON.stringify({
        ok: true,
        status: {
          logical_surface_height: 700,
          logical_surface_width: 1100,
          pane_geometry_coordinate_space: "compositor_logical",
          physical_output_height: 2160,
          physical_output_width: 3840,
        },
      })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const failed = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(failed.ok, true);
      assert.equal(failed.op, "target.apply.result");
      assert.equal(failed.payload.status, "failed");
      assert.equal(failed.payload.errorCode, "materialization_failed");
      assert.match(failed.payload.message, /outside compositor logical surface 1100x700/);
      assert.deepEqual(received, [{ type: "get_status" }]);
      assert.equal(failed.payload.materializedState?.hostResponse, null);
      assert.deepEqual(failed.payload.materializedState?.preflightStatus, {
        ok: true,
        status: {
          logical_surface_height: 700,
          logical_surface_width: 1100,
          pane_geometry_coordinate_space: "compositor_logical",
          physical_output_height: 2160,
          physical_output_width: 3840,
        },
      });

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server ignores reply races when the requester closes before the response", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const transient = await connect(url);
    transient.send(JSON.stringify(pairRequest(surfaceId, "pv_alpha")));
    transient.terminate();

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const stable = await connect(url);
    const response = await request(stable, surfacesListRequest());
    assert.equal(response.ok, true);
    assert.equal(response.op, "surfaces.list");
    await closeSocket(stable);
  });
});

test("ws server sanitizes stale layout pane ids before pane.split responds", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const surface = core.getSurface(surfaceId) as unknown as {
      layout: {
        children: Array<{ paneId: number; type: "pane" }>;
        direction: "horizontal" | "vertical";
        type: "split";
      };
    };
    surface.layout = {
      children: [
        { paneId: 1, type: "pane" },
        { paneId: 9999, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    };

    const contentSet = await request(owner, contentSetRequest(1));
    assert.equal(contentSet.ok, true);

    const contentClear = await request(owner, contentClearRequest(1, 2));
    assert.equal(contentClear.ok, true);

    const split = await request(owner, paneSplitRequest(1, { newPaneIds: [2], newPaneLabels: [2] }));
    assert.equal(split.ok, true);
    assert.equal(split.op, "pane.split");
    assert.deepEqual(split.payload.panes, [
      { paneId: 1, paneLabel: 1 },
      { paneId: 2, paneLabel: 2 },
    ]);

    await closeSocket(owner);
  });
});

test("ws server snapshot.get preserves pane drawings across owner resume", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const contentSet = await request(owner, contentSetRequest(1));
    assert.equal(contentSet.ok, true);

    core.setAnnotating(surfaceId, 1, true);
    core.addStroke(surfaceId, 1, {
      points: [
        { pressure: 0.2, timestamp: 100, x: 10, y: 20 },
        { pressure: 0.3, timestamp: 120, x: 30, y: 40 },
      ],
      strokeId: "stroke_reconnect" as never,
      tool: "mouse",
    });

    const beforeDisconnect = await request(owner, snapshotGetRequest(1));
    assert.equal(beforeDisconnect.ok, true);
    assert.deepEqual(
      beforeDisconnect.payload.drawings?.map((stroke) => stroke.strokeId),
      ["stroke_reconnect"],
    );

    await closeSocket(owner, 1000, "provider_shutdown");
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const resumedSocket = await connect(url);
    const resumed = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", { resumeSessionId: paired.payload.sessionId }),
    );
    assert.equal(resumed.ok, true);
    assert.equal(resumed.payload.resumed, true);

    const afterResume = await request(resumedSocket, snapshotGetRequest(1));
    assert.equal(afterResume.ok, true);
    assert.equal(afterResume.payload.contentId, "ct_snapshot");
    assert.deepEqual(
      afterResume.payload.drawings?.map((stroke) => stroke.strokeId),
      ["stroke_reconnect"],
    );

    await closeSocket(resumedSocket);
  });
});

test("ws server emits annotation_committed after the final drawing flush when annotation exits", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const contentSet = await request(owner, contentSetRequest(1));
    assert.equal(contentSet.ok, true);

    core.setAnnotating(surfaceId, 1, true);
    core.addStroke(surfaceId, 1, {
      points: [
        { pressure: 0.2, timestamp: 100, x: 10, y: 20 },
        { pressure: 0.3, timestamp: 120, x: 30, y: 40 },
      ],
      strokeId: "stroke_commit" as never,
      tool: "mouse",
    });

    const eventsPromise = collectEvents(owner, 2, [
      "event.drawing_flush",
      "event.annotation_committed",
    ]);
    core.setAnnotating(surfaceId, 1, false);

    const events = await eventsPromise;
    assert.equal(events[0]?.op, "event.drawing_flush");
    assert.equal(events[1]?.op, "event.annotation_committed");
    assert.equal(events[0]?.payload.paneId, 1);
    assert.equal(events[1]?.payload.paneId, 1);
    assert.equal(events[1]?.payload.contentId, "ct_snapshot");

    await closeSocket(owner);
  });
});

test("ws server accepts topology.apply and content.apply over the paired surface session", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const topology = await request(owner, topologyApplyRequest());
    assert.equal(topology.ok, true);
    assert.equal(topology.op, "topology.apply");
    assert.equal(topology.payload.topologyRevision, 7);
    assert.equal(topology.payload.panes[0]?.name, "Left");
    assert.equal(topology.payload.panes[0]?.paneId, 1);
    assert.equal(topology.payload.panes[0]?.paneLabel, 41);
    assert.match(topology.payload.panes[0]?.paneLineageId ?? "", /^pl_[a-f0-9]{32}$/);
    assert.equal(topology.payload.panes[1]?.name, "Right");
    assert.equal(topology.payload.panes[1]?.paneId, 2);
    assert.equal(topology.payload.panes[1]?.paneLabel, 42);
    assert.match(topology.payload.panes[1]?.paneLineageId ?? "", /^pl_[a-f0-9]{32}$/);
    assert.notEqual(topology.payload.panes[0]?.paneLineageId, topology.payload.panes[1]?.paneLineageId);

    const content = await request(owner, contentApplyRequest(1, 1));
    assert.equal(content.ok, true);
    assert.equal(content.op, "content.apply");
    assert.equal(content.payload.currentContentId, "ct_applied");
    assert.equal(content.payload.topologyRevision, 7);

    const panes = await request(owner, {
      id: `rq_${Math.random().toString(16).slice(2)}` as never,
      op: "panes.list",
      payload: {},
      sentAt: Date.now() as never,
      type: "request",
      v: 1,
    });
    assert.equal(panes.ok, true);
    assert.deepEqual(panes.payload.panes.map((pane) => [pane.paneId, pane.paneLabel, pane.name]), [
      [1, 41, "Left"],
      [2, 42, "Right"],
    ]);

    await closeSocket(owner);
  });
});
