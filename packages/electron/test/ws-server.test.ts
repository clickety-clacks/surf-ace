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

function waitForSocketClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
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
    initialPaneId?: number;
    initialPaneLabel?: number;
    providerName?: string | null;
    resumeSessionId?: string;
    takeover?: boolean;
    windowLabel?: string;
  } = {},
): PairRequest {
  const payload: PairRequest["payload"] = {
    connectionId: `conn_${Math.random().toString(16).slice(2)}` as never,
    initialPaneId: (options.initialPaneId ?? 1) as never,
    initialPaneLabel: options.initialPaneLabel ?? 1,
    protocolVersion: 1,
    providerId: providerId as never,
    providerName: options.providerName ?? "test-harness",
    resume: options.resumeSessionId
      ? { sessionId: options.resumeSessionId as never }
      : undefined,
    surfaceId: surfaceId as never,
    takeover: options.takeover ?? false,
    windowLabel: options.windowLabel ?? "a",
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
      windowLabel: "a",
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function seedHorizontalSplitSnapshots(core: SurfaceCore, surfaceId: string, topPaneId = 1, bottomPaneId = 2): void {
  core.updatePaneSnapshot(surfaceId, topPaneId, {
    bounds: { height: 400, width: 1200, x: 0, y: 0 },
  });
  core.updatePaneSnapshot(surfaceId, bottomPaneId, {
    bounds: { height: 400, width: 1200, x: 0, y: 400 },
  });
}

async function waitForRendererPaneSet(core: SurfaceCore, surfaceId: string, paneIds: number[]): Promise<void> {
  const expected = new Set(paneIds);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const live = new Set(core.getRendererWindowState(surfaceId).panes.map((pane) => pane.paneId));
    if ([...expected].every((paneId) => live.has(paneId))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`renderer pane set did not include ${paneIds.join(",")}`);
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

function contentApplyClearRequest(paneId: number, revision: number): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "content.apply",
    payload: {
      clear: true,
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
    ownershipEpoch: number;
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
      ownershipEpoch: overrides.ownershipEpoch ?? 1,
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
    ownershipEpoch?: number;
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
      ownershipEpoch: options.ownershipEpoch ?? 1,
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

function paneCloseRequest(paneId: number): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "pane.close",
    payload: { paneId: paneId as never },
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
    capturePaneImage?: (surfaceId: string, paneId: number) => Promise<string | null>;
    compositorSocketPath?: string | null;
    getOverlayDiagnostics?: (surfaceId: string) => Record<string, unknown> | null;
    onNativeMaterialized?: (surfaceId: string) => void;
    onNativeReleased?: (surfaceId: string, paneIds: string[]) => void;
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
    capturePaneImage: options.capturePaneImage ?? (async () => null),
    core,
    endpointName: "Surf Ace",
    getOverlayDiagnostics: options.getOverlayDiagnostics,
    hostName: "localhost",
    compositorSocketPath: options.compositorSocketPath ?? null,
    onNativeMaterialized: options.onNativeMaterialized,
    onNativeReleased: options.onNativeReleased,
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

test("ws server snapshot.get captures explicit rendered pane image", async () => {
  const captureRequests: Array<{ paneId: number; surfaceId: string }> = [];
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const response = await request(owner, {
      ...snapshotGetRequest(1),
      payload: {
        includeDrawings: true,
        includeImage: true,
        includeVisibleText: true,
        paneId: 1 as never,
      },
    });

    assert.equal(response.ok, true);
    assert.equal(response.op, "snapshot.get");
    assert.equal(response.payload.paneId, 1);
    assert.equal(response.payload.image, "cG5nLWJ5dGVz");
    assert.deepEqual(captureRequests, [{ paneId: 1, surfaceId }]);

    await closeSocket(owner);
  }, {
    capturePaneImage: async (surfaceId, paneId) => {
      captureRequests.push({ paneId, surfaceId });
      return "cG5nLWJ5dGVz";
    },
  });
});

test("ws server keeps ownership lock after owner socket closes", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    assert.equal(first.payload.ownershipEpoch, 1);
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

test("ws server surfaces.list remains discovery-only before pairing", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const probe = await connect(url);
    try {
      const listed = await request(probe, surfacesListRequest());
      assert.equal(listed.ok, true);
      assert.equal(listed.op, "surfaces.list");

      const surface = listed.payload.surfaces.find((entry) => entry.surfaceId === surfaceId);
      assert.ok(surface);
      assert.equal("windowLabel" in surface, false);
      assert.equal("initialPaneId" in surface, false);
      assert.equal("initialPaneLabel" in surface, false);
    } finally {
      await closeSocket(probe);
    }
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

test("ws server rejects human strings as provider-supplied visible window IDs", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    try {
      for (const label of ["DOCS", "RACTER GRAPHICAL NATIVE"]) {
        const invalid = pairRequest(surfaceId, "pv_alpha");
        invalid.payload.windowLabel = label as never;

        const rejected = await request(socket, invalid);

        assert.equal(rejected.ok, false);
        assert.equal(rejected.op, "pair.request");
        assert.equal(rejected.error.code, "invalid_payload");
        assert.match(rejected.error.message, /windowLabel must be a lowercase alphabetic provider identity label/);
      }
    } finally {
      await closeSocket(socket);
    }
  });
});

test("ws server accepts provider window labels beyond zz", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const socket = await connect(url);
    try {
      const accepted = await request(socket, pairRequest(surfaceId, "pv_alpha", {
        windowLabel: "aaa",
      }));

      assert.equal(accepted.ok, true);
      assert.equal(accepted.op, "pair.request");
      assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "aaa");
    } finally {
      await closeSocket(socket);
    }
  });
});

test("ws server rejects invalid provider bootstrap without leaving an ownership lock", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    try {
      const invalid = pairRequest(surfaceId, "pv_alpha", {
        initialPaneId: 0,
        initialPaneLabel: 1,
        windowLabel: "a",
      });

      const rejected = await request(socket, invalid);

      assert.equal(rejected.ok, false);
      assert.equal(rejected.op, "pair.request");
      assert.equal(rejected.error.code, "invalid_payload");

      const listed = await request(socket, surfacesListRequest());
      assert.equal(listed.ok, true);
      assert.equal(listed.payload.surfaces.find((entry) => entry.surfaceId === surfaceId)?.paired, false);
    } finally {
      await closeSocket(socket);
    }
  });
});

test("ws server does not commit pair ownership when pair.response is not delivered", async () => {
  await withServer(async ({ server, surfaceId, url }) => {
    const originalReply = (server as unknown as {
      reply: (socket: WebSocket, response: Response) => Promise<boolean>;
    }).reply.bind(server);
    let dropPairResponse = true;
    (server as unknown as {
      reply: (socket: WebSocket, response: Response) => Promise<boolean>;
    }).reply = async (socket: WebSocket, response: Response) => {
      if (dropPairResponse && response.op === "pair.request" && response.ok) {
        dropPairResponse = false;
        return false;
      }
      return await originalReply(socket, response);
    };

    const owner = await connect(url);
    owner.send(JSON.stringify(pairRequest(surfaceId, "pv_alpha")));
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const probe = await connect(url);
    const listed = await request(probe, surfacesListRequest());
    assert.equal(listed.ok, true);
    assert.equal(listed.op, "surfaces.list");
    assert.equal(listed.payload.surfaces.find((entry) => entry.surfaceId === surfaceId)?.paired, false);

    await closeSocket(probe);
    await closeSocket(owner);
  });
});

test("ws server rejects invalid topology.apply authority payloads before provider relabel", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    try {
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const invalid = topologyApplyRequest();
      invalid.payload.windowLabel = "docs" as never;
      invalid.payload.panes[1]!.paneLabel = 41;

      const rejected = await request(owner, invalid);

      assert.equal(rejected.ok, false);
      assert.equal(rejected.op, "topology.apply");
      assert.equal(rejected.error.code, "invalid_payload");
      assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "a");
    } finally {
      await closeSocket(owner);
    }
  });
});

test("ws server adopts provider window relabels on topology.apply", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    try {
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha", {
        windowLabel: "h",
      }));
      assert.equal(paired.ok, true);
      assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "h");

      const rejectedRelabel = topologyApplyRequest();
      rejectedRelabel.payload.windowLabel = "a";
      rejectedRelabel.payload.panes[1]!.paneLabel = 41;

      const rejected = await request(owner, rejectedRelabel);

      assert.equal(rejected.ok, false);
      assert.equal(rejected.op, "topology.apply");
      assert.equal(rejected.error.code, "invalid_payload");
      assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "h");

      const relabeled = topologyApplyRequest();
      relabeled.payload.windowLabel = "a";

      const acceptedPromise = request(owner, relabeled);
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const accepted = await acceptedPromise;

      assert.equal(accepted.ok, true);
      assert.equal(accepted.op, "topology.apply");
      assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "a");
    } finally {
      await closeSocket(owner);
    }
  });
});

test("ws server adopts provider window relabels on resumed pair", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha", {
      windowLabel: "h",
    }));
    assert.equal(first.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "h");
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const resumedSocket = await connect(url);
    const resumed = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", {
        resumeSessionId: first.payload.sessionId,
        windowLabel: "a",
      }),
    );

    assert.equal(resumed.ok, true);
    assert.equal(resumed.op, "pair.request");
    assert.equal(resumed.payload.resumed, true);
    assert.equal(resumed.payload.sessionId, first.payload.sessionId);
    assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "a");

    await closeSocket(resumedSocket);
  });
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
    assert.equal(resumed.payload.ownershipEpoch, first.payload.ownershipEpoch);

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
    assert.equal(reclaimed.payload.ownershipEpoch, first.payload.ownershipEpoch + 1);

    await closeSocket(replacement);
  });
});

test("ws server allows explicit same-provider takeover without the old resume session while the old socket is active", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);

    const takeover = await connect(url);
    const superseded = new Promise<{ code: number; reason: string }>((resolve) => {
      owner.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    const second = await request(
      takeover,
      pairRequest(surfaceId, "pv_alpha", { takeover: true }),
    );

    assert.equal(second.ok, true);
    assert.equal(second.op, "pair.request");
    assert.equal(second.payload.resumed, false);
    assert.notEqual(second.payload.sessionId, first.payload.sessionId);
    assert.equal(second.payload.ownershipEpoch, first.payload.ownershipEpoch + 1);
    assert.deepEqual(await superseded, { code: 1000, reason: "superseded" });

    await closeSocket(takeover);
  });
});

test("ws server rejects duplicate same-provider pair requests without resume while the active socket is still open", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);

    const duplicate = await connect(url);
    const rejected = await request(duplicate, pairRequest(surfaceId, "pv_alpha"));

    assert.equal(rejected.ok, false);
    assert.equal(rejected.op, "pair.request");
    assert.equal(rejected.error.code, "invalid_resume");
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

test("ws server resumes same-provider pair requests with a valid resume token while the old socket is active", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);

    const ownerClosed = waitForSocketClose(owner);
    const resumedSocket = await connect(url);
    const resumed = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", { resumeSessionId: first.payload.sessionId }),
    );

    assert.equal(resumed.ok, true);
    assert.equal(resumed.op, "pair.request");
    assert.equal(resumed.payload.resumed, true);
    assert.equal(resumed.payload.sessionId, first.payload.sessionId);
    assert.equal(resumed.payload.ownershipEpoch, first.payload.ownershipEpoch);
    assert.deepEqual(await ownerClosed, { code: 1000, reason: "superseded" });

    await closeSocket(resumedSocket);
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

test("ws server scopes explicit takeover to the requested surface only", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const otherSurface = core.createAdditionalSurface("Surf Ace B", { height: 700, scale: 2, width: 1000 });
    const ownerA = await connect(url);
    const firstA = await request(ownerA, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(firstA.ok, true);
    const ownerB = await connect(url);
    const firstB = await request(
      ownerB,
      pairRequest(otherSurface.surfaceId, "pv_alpha", {
        windowLabel: "b",
      }),
    );
    assert.equal(firstB.ok, true);

    const takeoverA = await connect(url);
    const supersededA = new Promise<{ code: number; reason: string }>((resolve) => {
      ownerA.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    const secondA = await request(
      takeoverA,
      pairRequest(surfaceId, "pv_bravo", { takeover: true }),
    );

    assert.equal(secondA.ok, true);
    assert.notEqual(secondA.payload.sessionId, firstA.payload.sessionId);
    assert.deepEqual(await supersededA, { code: 1000, reason: "superseded" });
    assert.equal(ownerB.readyState, WebSocket.OPEN);

    const panesB = await request(ownerB, {
      id: `rq_${Math.random().toString(16).slice(2)}` as never,
      op: "panes.list",
      payload: {},
      sentAt: Date.now() as never,
      type: "request",
      v: 1,
    });
    assert.equal(panesB.ok, true);
    assert.equal(panesB.op, "panes.list");

    await closeSocket(takeoverA);
    await closeSocket(ownerB);
  });
});

test("ws server rejects duplicate-label takeover before detaching the active owner", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const otherSurface = core.createAdditionalSurface("Surf Ace B", { height: 700, scale: 2, width: 1000 });
    const ownerA = await connect(url);
    const firstA = await request(ownerA, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(firstA.ok, true);

    const ownerB = await connect(url);
    const firstB = await request(
      ownerB,
      pairRequest(otherSurface.surfaceId, "pv_alpha", {
        windowLabel: "b",
      }),
    );
    assert.equal(firstB.ok, true);

    const takeoverB = await connect(url);
    const rejected = await request(
      takeoverB,
      pairRequest(otherSurface.surfaceId, "pv_bravo", {
        takeover: true,
        windowLabel: "a",
      }),
    );

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "invalid_payload");
    assert.match(rejected.error.message, /Duplicate windowLabel in live surface set: a/);
    assert.equal(ownerB.readyState, WebSocket.OPEN);

    const panesB = await request(ownerB, {
      id: `rq_${Math.random().toString(16).slice(2)}` as never,
      op: "panes.list",
      payload: {},
      sentAt: Date.now() as never,
      type: "request",
      v: 1,
    });
    assert.equal(panesB.ok, true);
    assert.equal(core.getRendererWindowState(otherSurface.surfaceId).windowLabel, "b");

    await closeSocket(takeoverB);
    await closeSocket(ownerB);
    await closeSocket(ownerA);
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

test("ws server rejects target.apply with stale ownership epoch", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);

    const takeover = await connect(url);
    const second = await request(takeover, pairRequest(surfaceId, "pv_alpha", { takeover: true }));
    assert.equal(second.ok, true);

    const rejected = await request(takeover, targetApplyRequest({
      ownershipEpoch: first.payload.ownershipEpoch,
      ownershipSessionId: second.payload.sessionId,
      paneLineageId: second.payload.state.panes[0]!.paneLineageId,
      surfaceId: second.payload.surfaceId,
    }));

    assert.equal(rejected.ok, true);
    assert.equal(rejected.op, "target.apply.result");
    assert.equal(rejected.payload.status, "rejected");
    assert.equal(rejected.payload.errorCode, "ownership_epoch_mismatch");

    await closeSocket(takeover);
  });
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

test("ws server rejects browser_url load confirmation after ownership changes", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    const pane = paired.payload.state.panes[0]!;

    const responsePromise = request(owner, browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: pane.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_raced",
      url: "https://race.example/",
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentType, "browser_url");

    const takeover = await request(owner, pairRequest(surfaceId, "pv_bravo", { takeover: true }));
    assert.equal(takeover.ok, true);
    server.resolveBrowserUrlNavigation(surfaceId, Number(pane.paneId), {
      status: "applied",
      targetId: "target_raced",
      url: "https://race.example/",
    });

    const response = await responsePromise;
    assert.equal(response.ok, true);
    assert.equal(response.op, "target.apply.result");
    assert.equal(response.payload.status, "rejected");
    assert.equal(response.payload.errorCode, "ownership_session_mismatch");
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

test("ws server rejects renderer replacement when native release overlay resync fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
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
      socket.write(`${JSON.stringify(message.type === "get_status"
        ? {
            ok: true,
            status: {
              logical_surface_height: 3840,
              logical_surface_width: 2160,
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
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.ok, true);
      assert.equal(nativeApplied.payload.status, "applied");

      const replaced = await request(owner, contentApplyRequest(Number(pane.paneId), 1));
      assert.equal(replaced.ok, false);
      assert.equal(replaced.error.code, "render_failed");
      await closeSocket(owner);
    }, {
      compositorSocketPath: socketPath,
      onNativeReleased: () => {
        throw new Error("overlay resync rejected");
      },
    });
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
      assert.equal(rejected.payload.message, "Target materialization failed");
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

test("ws server releases native-hosted pane before renderer content.apply", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const released: Array<{ paneIds: string[]; surfaceId: string }> = [];
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      const applied = await request(owner, contentApplyRequest(Number(pane.paneId), 1));
      assert.equal(applied.ok, true);
      assert.equal(applied.op, "content.apply");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "native_pane.release",
      ]);
      assert.deepEqual(received[3], {
        pane_ids: [String(pane.paneId)],
        type: "native_pane.release",
      });
      assert.deepEqual(released, [{ paneIds: [String(pane.paneId)], surfaceId }]);
      const rendererPane = core.getRendererWindowState(surfaceId).panes[0]!;
      assert.equal(rendererPane.externalNative, false);
      assert.equal(rendererPane.content.contentType, "markdown");

      await closeSocket(owner);
    }, {
      compositorSocketPath: socketPath,
      onNativeReleased: (releasedSurfaceId, paneIds) => released.push({ paneIds, surfaceId: releasedSurfaceId }),
    });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server preserves native-hosted pane when renderer content release fails", async () => {
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");

      const rejected = await request(owner, contentApplyRequest(Number(pane.paneId), 1));
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "render_failed");
      assert.equal(rejected.error.message, "release denied");
      const rendererPane = core.getRendererWindowState(surfaceId).panes[0]!;
      assert.equal(rendererPane.externalNative, true);
      assert.equal(rendererPane.content.contentType, null);
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

test("ws server releases native-hosted pane for content.apply clear next revision", async () => {
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      const cleared = await request(owner, contentApplyClearRequest(Number(pane.paneId), 1));
      assert.equal(cleared.ok, true);
      assert.equal(cleared.op, "content.apply");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "native_pane.release",
      ]);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, false);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server does not release native-hosted pane before invalid topology.apply validation", async () => {
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      const rejected = await request(owner, {
        id: `rq_${Math.random().toString(16).slice(2)}` as never,
        op: "topology.apply",
        payload: {
          layout: { paneId: 2 as never, type: "pane" },
          panes: [
            { name: "Two", paneId: 2 as never, paneLabel: 7 },
            { name: "Three", paneId: 3 as never, paneLabel: 7 },
          ],
          topologyRevision: 8 as never,
          windowLabel: "a",
        },
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "invalid_payload");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server preserves native-hosted pane for topology.apply with unchanged geometry", async () => {
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);
      core.updatePaneSnapshot(surfaceId, Number(pane.paneId), {
        bounds: { height: 800, width: 1200, x: 0, y: 0 },
      });

      const topology = await request(owner, {
        id: `rq_${Math.random().toString(16).slice(2)}` as never,
        op: "topology.apply",
        payload: {
          layout: { paneId: pane.paneId, type: "pane" },
          panes: [
            { name: "Renamed", paneId: pane.paneId, paneLabel: pane.paneLabel },
          ],
          topologyRevision: 9 as never,
          windowLabel: "a",
        },
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
      assert.equal(topology.ok, true);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server updates retained native-hosted panes after topology.apply changes geometry", async () => {
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);
      core.updatePaneSnapshot(surfaceId, Number(pane.paneId), {
        bounds: { height: 400, width: 1200, x: 0, y: 0 },
      });

      const topologyPromise = request(owner, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const topology = await topologyPromise;
      assert.equal(topology.ok, true);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      assert.equal((received[4] as { panes: Array<{ id: string }> }).panes[0]!.id, String(pane.paneId));
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);
      assert.equal(core.getRendererWindowState(surfaceId).panes.length, 2);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rejects retained native topology.apply when compositor geometry update fails", async () => {
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
      if (message.type === "native_pane.update") {
        socket.write(`${JSON.stringify({ error: "update denied", ok: false })}\n`);
      } else if (message.type === "get_status") {
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");

      const rejected = await request(owner, topologyApplyRequest());
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "render_failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
      ]);
      const state = core.getRendererWindowState(surfaceId);
      assert.equal(state.panes.length, 1);
      assert.equal(state.panes[0]!.label, "1");
      assert.equal(state.panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rolls back retained native topology geometry when overlay update fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let overlayRequests = 0;
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
      } else if (message.type === "overlay_regions.set") {
        overlayRequests += 1;
        socket.write(`${JSON.stringify(overlayRequests === 2 ? { error: "overlay denied", ok: false } : { ok: true })}\n`);
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");

      const rejected = await request(owner, topologyApplyRequest());
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "render_failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const state = core.getRendererWindowState(surfaceId);
      assert.equal(state.panes.length, 1);
      assert.equal(state.panes[0]!.label, "1");
      assert.equal(state.panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rolls back native resume relabel geometry when overlay update fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let overlayRequests = 0;
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
      } else if (message.type === "overlay_regions.set") {
        overlayRequests += 1;
        socket.write(`${JSON.stringify(overlayRequests === 2 ? { error: "overlay denied", ok: false } : { ok: true })}\n`);
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
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha", {
        windowLabel: "h",
      }));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      await closeSocket(owner, 1000, "provider_shutdown");

      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });

      const resumedSocket = await connect(url);
      const rejected = await request(
        resumedSocket,
        pairRequest(surfaceId, "pv_alpha", {
          resumeSessionId: paired.payload.sessionId,
          windowLabel: "a",
        }),
      );

      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "render_failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const state = core.getRendererWindowState(surfaceId);
      assert.equal(state.windowLabel, "h");
      assert.equal(state.panes.length, 1);
      assert.equal(state.panes[0]!.externalNative, true);

      await closeSocket(resumedSocket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rolls back retained native topology geometry when source geometry changes during update", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let mutateDuringUpdate: (() => void) | null = null;
  let updateRequests = 0;
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
      if (message.type === "native_pane.update") {
        updateRequests += 1;
        if (updateRequests === 1) {
          mutateDuringUpdate?.();
        }
      }
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      mutateDuringUpdate = () => {
        core.setViewport(surfaceId, { height: 800, scale: 2, width: 1300 });
      };

      const rejected = await request(owner, topologyApplyRequest());
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "render_failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const state = core.getRendererWindowState(surfaceId);
      assert.equal(state.panes.length, 1);
      assert.equal(state.panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server updates native-hosted pane after pane.split changes geometry", async () => {
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      core.updatePaneSnapshot(surfaceId, Number(pane.paneId), {
        bounds: { height: 400, width: 1200, x: 0, y: 0 },
      });

      const splitPromise = request(owner, {
        id: `rq_${Math.random().toString(16).slice(2)}` as never,
        op: "pane.split",
        payload: {
          count: 2,
          direction: "horizontal",
          newPaneIds: [2 as never],
          newPaneLabels: [42],
          paneId: Number(pane.paneId) as never,
        },
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const split = await splitPromise;
      assert.equal(split.ok, true);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      assert.equal((received[4] as { panes: Array<{ id: string }> }).panes[0]!.id, String(pane.paneId));
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server updates retained native-hosted panes before pane.close commits geometry", async () => {
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      core.updatePaneSnapshot(surfaceId, Number(pane.paneId), {
        bounds: { height: 400, width: 1200, x: 0, y: 0 },
      });

      const topologyPromise = request(owner, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      core.updatePaneSnapshot(surfaceId, 2, {
        bounds: { height: 400, width: 1200, x: 0, y: 400 },
      });
      core.updatePaneSnapshot(surfaceId, Number(pane.paneId), {
        bounds: { height: 800, width: 1200, x: 0, y: 0 },
      });
      const topology = await topologyPromise;
      assert.equal(topology.ok, true);

      const close = await request(owner, paneCloseRequest(2));
      assert.equal(close.ok, true);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const update = received[7] as { panes: Array<{ geometry: { height: number; width: number; x: number; y: number }; id: string }> };
      assert.equal(update.panes[0]!.id, String(pane.paneId));
      assert.deepEqual({
        coordinateSpace: update.panes[0]!.geometry.coordinateSpace,
        height: update.panes[0]!.geometry.height,
        paneInstanceId: update.panes[0]!.geometry.paneInstanceId,
        topologyEpoch: update.panes[0]!.geometry.topologyEpoch,
        width: update.panes[0]!.geometry.width,
        x: update.panes[0]!.geometry.x,
        y: update.panes[0]!.geometry.y,
      }, {
        coordinateSpace: "compositor_logical",
        height: 800,
        paneInstanceId: pane.paneLineageId,
        topologyEpoch: 7,
        width: 1200,
        x: 0,
        y: 0,
      });
      const state = core.getRendererWindowState(surfaceId);
      assert.equal(state.panes.length, 1);
      assert.equal(state.panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server serializes native target.apply against renderer content replacement", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let releaseHost!: () => void;
  const hostRelease = new Promise<void>((resolve) => {
    releaseHost = resolve;
  });
  let hostSeen!: () => void;
  const hostSeenPromise = new Promise<void>((resolve) => {
    hostSeen = resolve;
  });
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
      const reply = () => {
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
      };
      if (message.type === "native_pane.host") {
        hostSeen();
        void hostRelease.then(reply);
        return;
      }
      reply();
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
      const pane = paired.payload.state.panes[0]!;

      const nativePromise = request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      await hostSeenPromise;

      const contentPromise = request(owner, contentApplyRequest(Number(pane.paneId), 1));
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentId, null);

      releaseHost();
      const nativeApplied = await nativePromise;
      assert.equal(nativeApplied.payload.status, "applied");
      const contentApplied = await contentPromise;
      assert.equal(contentApplied.ok, true);
      assert.equal(contentApplied.payload.currentContentId, "ct_applied");
      const finalPane = core.getRendererWindowState(surfaceId).panes[0]!;
      assert.equal(finalPane.externalNative, false);
      assert.equal(finalPane.content.contentId, "ct_applied");
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

test("ws server releases native host when ownership changes during native target.apply", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let triggerTakeover: (() => void) | null = null;
  let takeoverComplete: Promise<void> = Promise.resolve();
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
        socket.end();
        return;
      }
      if (message.type === "native_pane.host") {
        triggerTakeover?.();
        void takeoverComplete.then(() => {
          socket.write(`${JSON.stringify({ ok: true })}\n`);
          socket.end();
        });
        return;
      }
      socket.write(`${JSON.stringify({ ok: true })}\n`);
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
      const pane = paired.payload.state.panes[0]!;
      triggerTakeover = () => {
        takeoverComplete = request(owner, pairRequest(surfaceId, "pv_bravo", { takeover: true })).then((takeover) => {
          assert.equal(takeover.ok, true);
        });
      };

      const rejected = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(rejected.ok, true);
      assert.equal(rejected.op, "target.apply.result");
      assert.equal(rejected.payload.status, "rejected");
      assert.equal(rejected.payload.errorCode, "ownership_session_mismatch");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "native_pane.release",
      ]);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, false);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server does not release native-hosted last pane before pane.close validation", async () => {
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
      const pane = paired.payload.state.panes[0]!;

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      const rejected = await request(owner, {
        id: `rq_${Math.random().toString(16).slice(2)}` as never,
        op: "pane.close",
        payload: { paneId: Number(pane.paneId) as never },
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "invalid_operation");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

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
    await withServer(async ({ core, surfaceId, url }) => {
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
      assert.equal(applied.payload.materializedState?.nativeHost, "applied");
      assert.equal(applied.payload.materializedState?.overlayRegions, "applied");
      assert.equal("hostRequest" in applied.payload.materializedState!, false);
      assert.equal("preflightStatus" in applied.payload.materializedState!, false);
      assert.equal("preflightStatusSummary" in applied.payload.materializedState!, false);
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
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const topologyPromise = request(socket, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const topology = await topologyPromise;
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
        geometryRevision: 5,
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
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const topologyPromise = request(socket, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const topology = await topologyPromise;
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
        geometryRevision: 5,
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

test("ws server updates native host geometry before committing viewport resize", async () => {
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
    await withServer(async ({ server, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;

      const applied = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(applied.ok, true);
      received.length = 0;

      assert.equal(await server.setViewport(surfaceId, { height: 400, scale: 2, width: 600 }), true);

      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const updatedPane = (received[1] as { panes: Array<Record<string, unknown>> }).panes[0]!;
      assert.deepEqual(updatedPane.geometry, {
        coordinateSpace: "compositor_logical",
        geometryRevision: 3,
        height: 400,
        paneInstanceId: pane.paneLineageId,
        surfaceEpoch: `${surfaceId}:2`,
        topologyEpoch: 0,
        width: 600,
        x: 0,
        y: 0,
      });

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rejects and releases stale native host plan after async geometry change", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let mutateDuringHost: (() => void) | null = null;
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
      if (message.type === "native_pane.host") {
        mutateDuringHost?.();
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      } else if (message.type === "get_status") {
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
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      mutateDuringHost = () => {
        core.contentSet(surfaceId, {
          content: { markdown: "# replacement" },
          contentId: "ct_replacement" as never,
          contentType: "markdown",
          historyOwnerToken: "hot_replacement",
          paneId: pane.paneId,
          revision: 1 as never,
        });
      };

      const failed = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(failed.ok, true);
      assert.equal(failed.op, "target.apply.result");
      assert.equal(failed.payload.status, "failed");
      assert.equal(failed.payload.errorCode, "materialization_failed");
      assert.equal(failed.payload.message, "Target materialization failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "native_pane.release",
      ]);
      assert.deepEqual(failed.payload.materializedState, {
        nativeHost: "released_after_failure",
        overlayRegions: "not_requested",
      });
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, false);

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
      assert.equal(failed.payload.message, "Target materialization failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), ["get_status", "native_pane.host"]);
      assert.deepEqual(failed.payload.materializedState, {
        nativeHost: "not_applied",
        overlayRegions: "not_requested",
      });

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
      assert.equal(failed.payload.message, "Target materialization failed");
      assert.deepEqual(received, [{ type: "get_status" }]);
      assert.deepEqual(failed.payload.materializedState, {
        nativeHost: "not_applied",
        overlayRegions: "not_requested",
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

    const splitPromise = request(owner, paneSplitRequest(1, { newPaneIds: [2], newPaneLabels: [2] }));
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    seedHorizontalSplitSnapshots(core, surfaceId);
    const split = await splitPromise;
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
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const topologyPromise = request(owner, topologyApplyRequest());
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    seedHorizontalSplitSnapshots(core, surfaceId);
    const topology = await topologyPromise;
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

test("ws server acknowledges topology.apply only after panes.list identity has resolved geometry", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    let topologySettled = false;
    const topologyPromise = request(owner, topologyApplyRequest()).finally(() => {
      topologySettled = true;
    });
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    assert.equal(topologySettled, false);

    seedHorizontalSplitSnapshots(core, surfaceId);
    const topology = await topologyPromise;
    assert.equal(topology.ok, true);

    const panes = await request(owner, {
      id: `rq_${Math.random().toString(16).slice(2)}` as never,
      op: "panes.list",
      payload: {},
      sentAt: Date.now() as never,
      type: "request",
      v: 1,
    });
    assert.equal(panes.ok, true);
    assert.deepEqual(panes.payload.panes.map((pane) => [pane.paneId, pane.paneLabel]), [
      [1, 41],
      [2, 42],
    ]);

    await closeSocket(owner);
  });
});
