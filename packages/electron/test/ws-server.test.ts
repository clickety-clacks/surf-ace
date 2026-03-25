import assert from "node:assert/strict";
import test from "node:test";

import WebSocket from "ws";

import type { PairRequest, Request, Response } from "../../protocol/src/index.js";
import { SurfaceCore } from "../src/surface-core.js";
import { SurfaceWsServer } from "../src/ws-server.js";

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
    resumeSessionId?: string;
    takeover?: boolean;
  } = {},
): PairRequest {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "pair.request",
    payload: {
      connectionId: `conn_${Math.random().toString(16).slice(2)}` as never,
      initialPaneId: 1 as never,
      protocolVersion: 1,
      providerId: providerId as never,
      resume: options.resumeSessionId
        ? { sessionId: options.resumeSessionId as never }
        : undefined,
      surfaceId: surfaceId as never,
      takeover: options.takeover ?? false,
      windowLabel: "a",
    },
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

function contentSetRequest(paneId: number): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "content.set",
    payload: {
      content: { html: "<p>annotate</p>" },
      contentId: "ct_snapshot" as never,
      contentType: "html",
      historyOwnerToken: "hot_snapshot" as never,
      paneId: paneId as never,
      revision: 1 as never,
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

async function withServer(
  run: (ctx: { core: SurfaceCore; surfaceId: string; url: string; server: SurfaceWsServer }) => Promise<void>,
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
    hostName: "localhost",
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
