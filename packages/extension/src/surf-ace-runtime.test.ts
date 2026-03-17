import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocketServer } from "ws";

import type { SurfAceDiscoveryEndpoint, SurfAceDiscoveryService } from "./surf-ace-discovery.js";
import { createSurfAceRuntime } from "./surf-ace-runtime.js";

type TestPane = {
  contentId: string | null;
  contentType: string | null;
  drawings: string[];
  name: string | null;
  revision: number;
  viewport: {
    height: number;
    scale: number;
    width: number;
  };
};

class StaticDiscoveryService implements SurfAceDiscoveryService {
  private readonly listeners = new Set<(endpoints: SurfAceDiscoveryEndpoint[]) => void | Promise<void>>();

  constructor(private readonly endpoints: SurfAceDiscoveryEndpoint[]) {}

  async start(): Promise<void> {
    await this.refreshNow();
  }

  async stop(): Promise<void> {}

  async refreshNow(): Promise<void> {
    for (const listener of this.listeners) {
      await listener(this.getSnapshot());
    }
  }

  getSnapshot(): SurfAceDiscoveryEndpoint[] {
    return structuredClone(this.endpoints);
  }

  subscribe(listener: (endpoints: SurfAceDiscoveryEndpoint[]) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

class FakeSurfAceWsServer {
  readonly annotationsRemoveRequests: Array<{ contentId: string; paneId: number; strokeIds: string[] }> = [];
  readonly clearRequests: Array<{ paneId: number; revision: number }> = [];
  readonly contentSetRequests: Array<{
    contentId: string;
    contentType: string;
    paneId: number;
    revision: number;
  }> = [];
  readonly initialRemotePaneId = 41;
  readonly panes = new Map<number, TestPane>([
    [
      41,
      {
        contentId: null,
        contentType: null,
        drawings: [],
        name: null,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      },
    ],
  ]);

  pairedSocket: import("ws").WebSocket | null = null;
  readonly surfaceId = "sf_surface-a";

  private nextEventId = 1;
  private readonly wss: WebSocketServer;

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString("utf8")) as {
          id: string;
          op: string;
          payload?: Record<string, unknown>;
        };
        void this.handleMessage(socket, message);
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  sendDrawingFlush(paneId: number, contentId: string): void {
    const pane = this.panes.get(paneId);
    assert.ok(pane);
    this.pairedSocket?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.drawing_flush",
        payload: {
          contentId,
          firstStrokeAt: 100,
          flushId: "fl_test",
          flushReason: "idle_window",
          idleWindowMs: 8000,
          lastStrokeAt: 120,
          maxIntervalMs: 30000,
          paneId,
          pointsCount: 2,
          revision: pane.revision,
          strokeCount: 1,
          strokes: [
            {
              points: [
                { pressure: 0.2, timestamp: 100, x: 10, y: 20 },
                { pressure: 0.4, timestamp: 120, x: 30, y: 40 },
              ],
              strokeId: "stroke_abc123",
            },
          ],
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
    pane.drawings = ["stroke_abc123"];
  }

  sendNavigation(paneId: number, contentId: string, url: string): number {
    const pane = this.panes.get(paneId);
    assert.ok(pane);
    const sentAt = Date.now();
    this.pairedSocket?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.navigation",
        payload: {
          contentId,
          paneId,
          revision: pane.revision,
          url,
        },
        sentAt,
        type: "event",
        v: 1,
      }),
    );
    return sentAt;
  }

  private async handleMessage(
    socket: import("ws").WebSocket,
    message: { id: string; op: string; payload?: Record<string, unknown> },
  ): Promise<void> {
    switch (message.op) {
      case "surfaces.list":
        socket.send(
          JSON.stringify(
            this.response(message.id, "surfaces.list", {
              surfaces: [
                {
                  name: "Surface A",
                  paired: Boolean(this.pairedSocket),
                  surfaceId: this.surfaceId,
                  viewport: { height: 768, scale: 2, width: 1024 },
                },
              ],
            }),
          ),
        );
        return;
      case "pair.request":
        this.pairedSocket = socket;
        socket.send(
          JSON.stringify(
            this.response(message.id, "pair.request", {
              capabilities: {
                contentTypes: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"],
                eventTypes: [
                  "event.drawing_flush",
                  "event.tap",
                  "event.selection",
                  "event.page",
                  "event.navigation",
                  "event.snapshot_hint",
                ],
              },
              eventConfig: {
                activeEvents: [
                  "event.drawing_flush",
                  "event.tap",
                  "event.selection",
                  "event.page",
                  "event.navigation",
                  "event.snapshot_hint",
                ],
                drawingFlushConfig: {
                  idleWindowMs: 8000,
                  maxIntervalMs: 30000,
                },
                profile: "minimum_deep",
              },
              limits: {
                maxDrawingFlushBytes: 2 * 1024 * 1024,
                maxFrameBytes: 10 * 1024 * 1024,
                maxMessageBytes: 12 * 1024 * 1024,
                maxStrokePointsPerFlush: 8192,
                maxVisibleTextBytes: 4096,
                resumeGraceMs: 20_000,
              },
              resumed: false,
              sessionId: "sa_test_session",
              state: {
                panes: [...this.panes.entries()].map(([paneId, pane]) => ({
                  contentType: pane.contentType,
                  currentContentId: pane.contentId,
                  currentRevision: pane.revision,
                  paneId,
                })),
              },
              surfaceId: this.surfaceId,
              surfaceName: "Surface A",
              viewport: { height: 768, scale: 2, width: 1024 },
            }),
          ),
        );
        return;
      case "panes.list":
        socket.send(
          JSON.stringify(
            this.response(message.id, "panes.list", {
              panes: [...this.panes.entries()].map(([paneId, pane]) => ({
                activeContentId: pane.contentId,
                contentType: pane.contentType,
                name: pane.name,
                paneId,
                viewport: pane.viewport,
              })),
            }),
          ),
        );
        return;
      case "snapshot.get": {
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = this.panes.get(paneId);
        assert.ok(pane);
        socket.send(
          JSON.stringify(
            this.response(message.id, "snapshot.get", {
              contentId: pane.contentId,
              contentType: pane.contentType,
              drawings: pane.drawings.map((strokeId) => ({
                points: [],
                strokeId,
              })),
              image: "aGVsbG8=",
              paneId,
              revision: pane.revision,
              selection: null,
              viewport: {
                contentSize: { height: 768, width: 1024 },
                scrollOffset: { x: 0, y: 0 },
                visibleRect: { height: 768, width: 1024, x: 0, y: 0 },
                zoomLevel: 1,
              },
              visibleText: pane.contentId ? "Visible text" : "",
            }),
          ),
        );
        return;
      }
      case "content.set": {
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = this.panes.get(paneId);
        assert.ok(pane);
        pane.contentId = String(message.payload?.contentId);
        pane.contentType = String(message.payload?.contentType);
        pane.revision = Number(message.payload?.revision ?? pane.revision + 1);
        pane.drawings = [];
        this.contentSetRequests.push({
          contentId: pane.contentId,
          contentType: pane.contentType,
          paneId,
          revision: pane.revision,
        });
        socket.send(
          JSON.stringify(
            this.response(message.id, "content.set", {
              contentId: pane.contentId,
              contentType: pane.contentType,
              currentContentId: pane.contentId,
              currentRevision: pane.revision,
              paneId,
            }),
          ),
        );
        return;
      }
      case "content.clear": {
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = this.panes.get(paneId);
        assert.ok(pane);
        pane.contentId = null;
        pane.contentType = null;
        pane.drawings = [];
        pane.revision = Number(message.payload?.revision ?? pane.revision + 1);
        this.clearRequests.push({
          paneId,
          revision: pane.revision,
        });
        socket.send(
          JSON.stringify(
            this.response(message.id, "content.clear", {
              contentId: null,
              currentContentId: null,
              currentRevision: pane.revision,
              paneId,
            }),
          ),
        );
        return;
      }
      case "annotations.remove": {
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = this.panes.get(paneId);
        assert.ok(pane);
        const strokeIds = Array.isArray(message.payload?.strokeIds)
          ? message.payload.strokeIds.map((value) => String(value))
          : [];
        const removedStrokeIds = strokeIds.filter((strokeId) => pane.drawings.includes(strokeId));
        pane.drawings = pane.drawings.filter((strokeId) => !removedStrokeIds.includes(strokeId));
        this.annotationsRemoveRequests.push({
          contentId: String(message.payload?.contentId ?? ""),
          paneId,
          strokeIds,
        });
        socket.send(
          JSON.stringify(
            this.response(message.id, "annotations.remove", {
              contentId: pane.contentId,
              notFoundStrokeIds: strokeIds.filter((strokeId) => !removedStrokeIds.includes(strokeId)),
              paneId,
              remainingStrokeCount: pane.drawings.length,
              removedStrokeIds,
            }),
          ),
        );
        return;
      }
      case "heartbeat.ping":
        socket.send(
          JSON.stringify(
            this.response(message.id, "heartbeat.ping", {
              nonce: message.payload?.nonce,
            }),
          ),
        );
        return;
      default:
        throw new Error(`Unhandled op in test server: ${message.op}`);
    }
  }

  private response(id: string, op: string, payload: Record<string, unknown>) {
    return {
      id,
      ok: true,
      op,
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("wait_for_timeout");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

let nextPort = 22119;

async function withRuntimeHarness(
  run: (ctx: {
    alertBodies: Array<Record<string, unknown>>;
    runtime: ReturnType<typeof createSurfAceRuntime>;
    server: FakeSurfAceWsServer;
  }) => Promise<void>,
): Promise<void> {
  const port = nextPort++;
  const server = new FakeSurfAceWsServer(port);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-"));
  const discovery = new StaticDiscoveryService([
    {
      busy: false,
      capabilitiesBitmask: 31,
      endpointId: `endpoint-${port}`,
      fingerprintPrefix: "abcd1234",
      host: "127.0.0.1",
      instanceName: "Test Surface",
      lastSeenAt: Date.now(),
      name: "Test Surface",
      port,
      protocolVersion: 1,
      viewport: { height: 768, scale: 2, width: 1024 },
      wsPath: "/ws",
    },
  ]);
  const runtime = createSurfAceRuntime({ discovery, stateDir });
  const alertBodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (_input, init) => {
      alertBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await runtime.start();
    await waitFor(() => server.pairedSocket !== null);
    await run({ alertBodies, runtime, server });
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.stop();
    await server.close();
    await fs.rm(stateDir, { force: true, recursive: true });
  }
}

test("surf ace runtime enforces spec-aligned provider behavior", async (t) => {
  await t.test("listScreens exposes only the CLU surface fields and local pane ids", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const screens = await runtime.listScreens();
      assert.equal(screens.length, 1);

      const screen = screens[0];
      assert.ok(screen);
      assert.deepEqual(
        Object.keys(screen).sort(),
        ["connectionState", "fingerprint", "lastSeenAt", "name", "panes", "pendingEvents", "viewport"].sort(),
      );
      assert.equal(screen.fingerprint, server.surfaceId);
      assert.deepEqual(screen.panes.map((pane) => pane.paneId), [1]);
      assert.deepEqual(
        Object.keys(screen.panes[0] ?? {}).sort(),
        ["activeContent", "historySummary", "name", "paneId"].sort(),
      );
    });
  });

  await t.test("provider keeps pane identity local and reuses content ownership per injected session", async () => {
    await withRuntimeHarness(async ({ alertBodies, runtime, server }) => {
      const localEvents: Array<{
        paneId: number;
        previousSessionKey: string;
        surfaceId: string;
        type: string;
        visibleContentId: string | null;
      }> = [];
      const unsubscribe = runtime.subscribe((event) => {
        if (event.type === "event.content_superseded") {
          localEvents.push(event);
        }
      });

      try {
        const first = await runtime.push(
          {
            content: "<p>first</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: 1,
          },
          { sessionKey: "agent:test:1" },
        );
        const second = await runtime.push(
          {
            content: "<p>second</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: 1,
          },
          { sessionKey: "agent:test:1" },
        );
        const third = await runtime.push(
          {
            content: "<p>third</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: 1,
          },
          { sessionKey: "agent:test:2" },
        );

        assert.equal(server.contentSetRequests.length, 3);
        assert.deepEqual(
          server.contentSetRequests.map((request) => request.paneId),
          [server.initialRemotePaneId, server.initialRemotePaneId, server.initialRemotePaneId],
        );
        assert.equal(first.paneId, 1);
        assert.equal(second.paneId, 1);
        assert.equal(third.paneId, 1);
        assert.equal(first.contentId, second.contentId);
        assert.notEqual(first.contentId, third.contentId);
        assert.deepEqual(localEvents, [
          {
            paneId: 1,
            previousSessionKey: "agent:test:1",
            surfaceId: server.surfaceId,
            type: "event.content_superseded",
            visibleContentId: first.contentId,
          },
        ]);

        const screens = await runtime.listScreens();
        assert.equal(screens[0]?.panes[0]?.historySummary.visibleContentId, third.contentId);
        assert.equal(screens[0]?.panes[0]?.historySummary.backCount, 1);

        server.sendDrawingFlush(server.initialRemotePaneId, third.contentId);
        await waitFor(() => alertBodies.length === 1);
        assert.deepEqual(alertBodies[0], {
          message: "Surf Ace updates pending on Surface A",
          noOverlay: true,
          sessionKey: "agent:main:main",
        });

        server.sendDrawingFlush(server.initialRemotePaneId, third.contentId);
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        assert.equal(alertBodies.length, 1);

        const read = await runtime.read({ fingerprint: server.surfaceId, paneId: 1 });
        assert.ok(read.liveDirtyStrokeIds.includes("stroke_abc123"));
        assert.equal(read.liveFrame?.contentId, third.contentId);

        server.sendDrawingFlush(server.initialRemotePaneId, third.contentId);
        await waitFor(() => alertBodies.length === 2);

        const removed = await runtime.annotateRemove({
          contentId: third.contentId,
          fingerprint: server.surfaceId,
          paneId: 1,
          strokeIds: ["stroke_abc123"],
        });
        assert.deepEqual(removed, {
          fingerprint: server.surfaceId,
          notFoundStrokeIds: [],
          paneId: 1,
          remainingStrokeCount: 0,
          removedStrokeIds: ["stroke_abc123"],
        });
        assert.deepEqual(server.annotationsRemoveRequests, [
          {
            contentId: third.contentId,
            paneId: server.initialRemotePaneId,
            strokeIds: ["stroke_abc123"],
          },
        ]);
      } finally {
        unsubscribe();
      }
    });
  });

  await t.test("provider discards non-html navigation events and keeps clear scoped to remote pane ids", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const markdownPush = await runtime.push(
        {
          content: "# notes",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: 1,
        },
        { sessionKey: "agent:test:1" },
      );

      server.sendNavigation(server.initialRemotePaneId, markdownPush.contentId, "https://example.com/ignored");
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const markdownRead = await runtime.read({ fingerprint: server.surfaceId, paneId: 1 });
      assert.equal(markdownRead.lastNavigation, null);

      const htmlPush = await runtime.push(
        {
          content: "<p>html</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: 1,
        },
        { sessionKey: "agent:test:1" },
      );

      const navigatedAt = server.sendNavigation(
        server.initialRemotePaneId,
        htmlPush.contentId,
        "https://example.com/live",
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const htmlRead = await runtime.read({ fingerprint: server.surfaceId, paneId: 1 });
      assert.deepEqual(htmlRead.lastNavigation, {
        navigatedAt,
        url: "https://example.com/live",
      });

      const clear = await runtime.clear({ fingerprint: server.surfaceId, paneId: 1 });
      assert.deepEqual(clear, {
        fingerprint: server.surfaceId,
        paneId: 1,
        revision: clear.revision,
      });
      assert.deepEqual(server.clearRequests.map((request) => request.paneId), [server.initialRemotePaneId]);
    });
  });
});
