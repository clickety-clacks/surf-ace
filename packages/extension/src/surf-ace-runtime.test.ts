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
  readonly panes = new Map<number, TestPane>([
    [
      1,
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
          revision: this.panes.get(paneId)?.revision ?? 0,
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
    const pane = this.panes.get(paneId);
    if (pane) {
      pane.drawings = ["stroke_abc123"];
    }
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
      case "content.append":
      case "content.patch": {
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = this.panes.get(paneId);
        assert.ok(pane);
        pane.revision = Number(message.payload?.revision ?? pane.revision + 1);
        socket.send(
          JSON.stringify(
            this.response(message.id, message.op, {
              contentId: pane.contentId,
              currentContentId: pane.contentId,
              currentRevision: pane.revision,
              paneId,
            }),
          ),
        );
        return;
      }
      case "pane.rename": {
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = this.panes.get(paneId);
        assert.ok(pane);
        pane.name = (message.payload?.name as string | null | undefined) ?? null;
        socket.send(
          JSON.stringify(
            this.response(message.id, "pane.rename", {
              name: pane.name,
              paneId,
            }),
          ),
        );
        return;
      }
      case "pane.split": {
        const sourcePaneId = Number(message.payload?.paneId ?? 0);
        assert.ok(this.panes.get(sourcePaneId));
        const newPaneIds = Array.isArray(message.payload?.newPaneIds)
          ? message.payload?.newPaneIds.map((value) => Number(value))
          : [];
        for (const paneId of newPaneIds) {
          this.panes.set(paneId, {
            contentId: null,
            contentType: null,
            drawings: [],
            name: null,
            revision: 0,
            viewport: {
              height: 768,
              scale: 2,
              width: 512,
            },
          });
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "pane.split", {
              panes: [...this.panes.keys()].sort((left, right) => left - right).map((paneId) => ({
                paneId,
              })),
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

test("runtime maintains WS state, local buffers, and pane operations", async () => {
  const port = 22119;
  const server = new FakeSurfAceWsServer(port);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-"));
  const discovery = new StaticDiscoveryService([
    {
      busy: false,
      capabilitiesBitmask: 31,
      endpointId: "endpoint-test",
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

  try {
    await runtime.start();
    await waitFor(() => server.pairedSocket !== null);

    const initialScreens = await runtime.listScreens();
    assert.equal(initialScreens.length, 1);
    assert.equal(initialScreens[0]?.windowLabel, "a");
    assert.deepEqual(initialScreens[0]?.panes.map((pane) => pane.paneId), [1]);

    const pushResult = await runtime.push({
      content: "<p>Hello</p>",
      contentType: "html",
      fingerprint: server.surfaceId,
      paneId: 1,
      sessionKey: "agent:test:1",
    });
    assert.equal(pushResult.op, "content.set");
    assert.equal(pushResult.paneId, 1);

    await runtime.push({
      fingerprint: server.surfaceId,
      name: "Primary",
      op: "pane.rename",
      paneId: 1,
    });
    const splitResult = await runtime.push({
      count: 2,
      direction: "horizontal",
      fingerprint: server.surfaceId,
      op: "pane.split",
      paneId: 1,
    });
    assert.equal(splitResult.op, "pane.split");
    assert.equal(splitResult.paneIds.length, 2);

    const updatedScreens = await runtime.listScreens();
    assert.deepEqual(
      updatedScreens[0]?.panes.map((pane) => pane.paneId),
      [1, splitResult.paneIds.find((paneId) => paneId !== 1) ?? 2],
    );
    assert.equal(updatedScreens[0]?.panes[0]?.name, "Primary");

    const activeContentId = server.panes.get(1)?.contentId;
    assert.ok(activeContentId);
    server.sendDrawingFlush(1, activeContentId as string);
    await waitFor(async () => {
      const screens = await runtime.listScreens();
      return (screens[0]?.pendingEvents ?? 0) > 0;
    }).catch(() => {
      throw new Error("drawing_flush_not_processed");
    });

    const readResult = await runtime.read({ fingerprint: server.surfaceId, paneId: 1 });
    console.log(JSON.stringify(readResult, null, 2));
    assert.equal(readResult.liveDirtyStrokeIds[0], "stroke_abc123");
    assert.equal(readResult.liveFrame?.strokes.length, 1);

    const removeResult = await runtime.annotateRemove({
      contentId: activeContentId as string,
      fingerprint: server.surfaceId,
      paneId: 1,
      strokeIds: ["stroke_abc123"],
    });
    assert.deepEqual(removeResult.removedStrokeIds, ["stroke_abc123"]);

    const snapshotResult = await runtime.snapshot({ fingerprint: server.surfaceId, paneId: 1 });
    assert.equal(snapshotResult.snapshot?.contentId, activeContentId);
  } finally {
    await runtime.stop();
    await server.close();
    await fs.rm(stateDir, { force: true, recursive: true });
  }
});
