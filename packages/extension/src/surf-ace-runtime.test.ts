import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocketServer } from "ws";
import type WebSocket from "ws";

import type { SurfAceDiscoveryEndpoint, SurfAceDiscoveryService } from "./surf-ace-discovery.js";
import { createSurfAceRuntime } from "./surf-ace-runtime.js";

type TestPane = {
  contentId: string | null;
  contentType: string | null;
  drawings: string[];
  name: string | null;
  paneLabel: number;
  revision: number;
  viewport: {
    height: number;
    scale: number;
    width: number;
  };
};

type TestSurfaceState = {
  name: string;
  panes: Map<number, TestPane>;
  surfaceId: string;
  viewport: {
    height: number;
    scale: number;
    width: number;
  };
};

class StaticDiscoveryService implements SurfAceDiscoveryService {
  private readonly listeners = new Set<(endpoints: SurfAceDiscoveryEndpoint[]) => void | Promise<void>>();
  private endpoints: SurfAceDiscoveryEndpoint[];

  constructor(endpoints: SurfAceDiscoveryEndpoint[]) {
    this.endpoints = endpoints;
  }

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

  setEndpoints(endpoints: SurfAceDiscoveryEndpoint[]): void {
    this.endpoints = structuredClone(endpoints);
  }

  subscribe(listener: (endpoints: SurfAceDiscoveryEndpoint[]) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

class FakeSurfAceWsServer {
  activeSocketCount = 0;
  readonly annotationsRemoveRequests: Array<{ contentId: string; paneId: number; strokeIds: string[] }> = [];
  busyWithoutTakeoverResponsesRemaining = 0;
  readonly clearRequests: Array<{ paneId: number; revision: number }> = [];
  readonly closePaneRequests: Array<{ paneId: number }> = [];
  readonly contentSetRequests: Array<{
    contentId: string;
    contentType: string;
    historyOwnerToken: string;
    paneId: number;
    revision: number;
  }> = [];
  readonly topologyApplyRequests: Array<{
    layout: unknown;
    paneIds: number[];
    paneLabels: number[];
    topologyRevision: number;
    windowLabel: string;
  }> = [];
  initialRemotePaneId: number;
  readonly pairAttemptDetails: Array<{
    providerId: string | null;
    providerName: string | null;
    resumeSessionId: string | null;
    takeover: boolean;
  }> = [];
  readonly pairRequests: Array<{ initialPaneId: number; initialPaneLabel: number; windowLabel: string }> = [];
  readonly pairRequestSurfaceIds: string[] = [];
  readonly panes: Map<number, TestPane>;
  readonly splitRequests: Array<{
    count: number;
    direction: string;
    newPaneIds: number[];
    newPaneLabels: number[];
    paneId: number;
  }> = [];
  snapshotDelayMs = 0;
  snapshotImage = "aGVsbG8=";
  snapshotRequests: Array<{ includeImage: boolean; includeVisibleText: boolean; paneId: number }> = [];
  snapshotScrollOffset = { x: 0, y: 0 };
  dropNextSplitRequest = false;
  forcedPairErrors: Array<{ code: string; message: string }> = [];
  invalidResumeWithoutTakeoverResponsesRemaining = 0;
  lockUntilNewProviderIdCode: "busy" | "invalid_resume" | null = null;
  lockUntilNewProviderIdProviderId: string | null = null;
  maxConcurrentSocketCount = 0;
  rejectNextResumePairWithSessionMismatch = false;
  resumePairMismatchResponsesRemaining = 0;
  resumePairMismatchMessage = "Resume session did not match active ownership lock";

  pairedSocket: import("ws").WebSocket | null = null;
  readonly surfaceId: string;

  private closed = false;
  private nextEventId = 1;
  private readonly pairedSocketsBySurfaceId = new Map<string, WebSocket>();
  private readonly socketSurfaceIds = new Map<WebSocket, string>();
  private readonly sockets = new Set<WebSocket>();
  private readonly surfaces = new Map<string, TestSurfaceState>();
  private readonly wss: WebSocketServer;

  constructor(port: number, options?: { initialRemotePaneId?: number; surfaceId?: string }) {
    this.initialRemotePaneId = options?.initialRemotePaneId ?? 41;
    this.surfaceId = options?.surfaceId ?? "sf_surface-a";
    this.panes = new Map<number, TestPane>([
      [
        this.initialRemotePaneId,
        {
          contentId: null,
          contentType: null,
          drawings: [],
          name: null,
          paneLabel: this.initialRemotePaneId,
          revision: 0,
          viewport: {
            height: 768,
            scale: 2,
            width: 1024,
          },
        },
      ],
    ]);
    this.surfaces.set(this.surfaceId, {
      name: "Surface A",
      panes: this.panes,
      surfaceId: this.surfaceId,
      viewport: {
        height: 768,
        scale: 2,
        width: 1024,
      },
    });
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (socket) => {
      this.sockets.add(socket);
      this.activeSocketCount = this.sockets.size;
      this.maxConcurrentSocketCount = Math.max(this.maxConcurrentSocketCount, this.activeSocketCount);
      socket.once("close", () => {
        this.sockets.delete(socket);
        this.activeSocketCount = this.sockets.size;
        const surfaceId = this.socketSurfaceIds.get(socket);
        if (surfaceId && this.pairedSocketsBySurfaceId.get(surfaceId) === socket) {
          this.pairedSocketsBySurfaceId.delete(surfaceId);
        }
        this.socketSurfaceIds.delete(socket);
        if (this.pairedSocket === socket) {
          this.pairedSocket = null;
        }
      });
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
    if (this.closed) {
      return;
    }
    this.closed = true;
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

  addSurface(options: {
    initialRemotePaneId?: number;
    name?: string;
    surfaceId: string;
    viewport?: {
      height: number;
      scale: number;
      width: number;
    };
  }): void {
    const viewport = options.viewport ?? {
      height: 768,
      scale: 2,
      width: 1024,
    };
    const initialRemotePaneId = options.initialRemotePaneId ?? 41;
    this.surfaces.set(options.surfaceId, {
      name: options.name ?? `Surface ${options.surfaceId}`,
      panes: new Map<number, TestPane>([
        [
          initialRemotePaneId,
          {
            contentId: null,
            contentType: null,
            drawings: [],
            name: null,
            paneLabel: initialRemotePaneId,
            revision: 0,
            viewport: { ...viewport },
          },
        ],
      ]),
      surfaceId: options.surfaceId,
      viewport,
    });
  }

  pairedSocketFor(surfaceId: string): import("ws").WebSocket | null {
    return this.pairedSocketsBySurfaceId.get(surfaceId) ?? null;
  }

  sendSurfaceAppeared(options: {
    fromSurfaceId?: string;
    initialRemotePaneId?: number;
    name?: string;
    surfaceId: string;
    viewport?: {
      height: number;
      scale: number;
      width: number;
    };
  }): void {
    if (!this.surfaces.has(options.surfaceId)) {
      this.addSurface(options);
    }
    const surface = this.requireSurface(options.surfaceId);
    this.pairedSocketFor(options.fromSurfaceId ?? this.surfaceId)?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.surface_appeared",
        payload: {
          name: surface.name,
          surfaceId: surface.surfaceId,
          viewport: surface.viewport,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
  }

  sendSurfaceRemoved(options: { fromSurfaceId?: string; surfaceId: string }): void {
    this.pairedSocketFor(options.fromSurfaceId ?? this.surfaceId)?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.surface_removed",
        payload: {
          surfaceId: options.surfaceId,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
    this.pairedSocketsBySurfaceId.get(options.surfaceId)?.close(1000, "surface_removed");
    this.surfaces.delete(options.surfaceId);
  }

  private requireSurface(surfaceId: string): TestSurfaceState {
    const surface = this.surfaces.get(surfaceId);
    assert.ok(surface, `unknown test surface ${surfaceId}`);
    return surface;
  }

  private requirePairedSurface(socket: import("ws").WebSocket): TestSurfaceState {
    const surfaceId = this.socketSurfaceIds.get(socket) ?? this.surfaceId;
    return this.requireSurface(surfaceId);
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

  sendAnnotationCommitted(paneId: number, contentId: string): void {
    const pane = this.panes.get(paneId);
    assert.ok(pane);
    this.pairedSocket?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.annotation_committed",
        payload: {
          committedAt: Date.now(),
          contentId,
          paneId,
          revision: pane.revision,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
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

  sendHistoryNavigated(
    paneId: number,
    options: {
      contentId: string | null;
      direction: "back" | "forward";
      fromSurfaceId?: string;
      revision: number;
    },
  ): void {
    this.pairedSocketFor(options.fromSurfaceId ?? this.surfaceId)?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.history_navigated",
        payload: {
          contentId: options.contentId,
          direction: options.direction,
          paneId,
          revision: options.revision,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
  }

  sendSnapshotHint(reason: "after_reconnect" | "after_render" | "backpressure_drop"): void {
    this.pairedSocket?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.snapshot_hint",
        payload: { reason },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
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
              surfaces: [...this.surfaces.values()].map((surface) => ({
                name: surface.name,
                paired: this.pairedSocketsBySurfaceId.has(surface.surfaceId),
                surfaceId: surface.surfaceId,
                viewport: surface.viewport,
              })),
            }),
          ),
        );
        return;
      case "pair.request":
        this.pairRequestSurfaceIds.push(String(message.payload?.surfaceId ?? this.surfaceId));
        this.pairRequests.push({
          initialPaneId: Number(message.payload?.initialPaneId ?? 0),
          initialPaneLabel: Number(message.payload?.initialPaneLabel ?? 0),
          windowLabel: String(message.payload?.windowLabel ?? ""),
        });
        this.pairAttemptDetails.push({
          providerId:
            typeof message.payload?.providerId === "string"
              ? String(message.payload.providerId)
              : null,
          providerName:
            typeof message.payload?.providerName === "string"
              ? String(message.payload.providerName)
              : null,
          resumeSessionId:
            typeof message.payload?.resume === "object" &&
            message.payload?.resume &&
            typeof (message.payload.resume as { sessionId?: unknown }).sessionId === "string"
              ? String((message.payload.resume as { sessionId: string }).sessionId)
              : null,
          takeover: Boolean(message.payload?.takeover),
        });
        if (
          this.lockUntilNewProviderIdCode &&
          this.lockUntilNewProviderIdProviderId &&
          this.pairAttemptDetails.at(-1)?.providerId === this.lockUntilNewProviderIdProviderId &&
          !message.payload?.takeover
        ) {
          const errorCode = this.lockUntilNewProviderIdCode;
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "pair.request",
                errorCode,
                errorCode === "busy"
                  ? "Surface is already paired"
                  : this.resumePairMismatchMessage,
              ),
            ),
          );
          return;
        }
        if (this.busyWithoutTakeoverResponsesRemaining > 0 && !message.payload?.takeover) {
          this.busyWithoutTakeoverResponsesRemaining -= 1;
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "pair.request",
                "busy",
                "Surface is already paired",
              ),
            ),
          );
          return;
        }
        if (this.invalidResumeWithoutTakeoverResponsesRemaining > 0 && !message.payload?.takeover) {
          this.invalidResumeWithoutTakeoverResponsesRemaining -= 1;
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "pair.request",
                "invalid_resume",
                this.resumePairMismatchMessage,
              ),
            ),
          );
          return;
        }
        if (
          (this.rejectNextResumePairWithSessionMismatch ||
            this.resumePairMismatchResponsesRemaining > 0) &&
          this.pairAttemptDetails.at(-1)?.resumeSessionId
        ) {
          this.rejectNextResumePairWithSessionMismatch = false;
          if (this.resumePairMismatchResponsesRemaining > 0) {
            this.resumePairMismatchResponsesRemaining -= 1;
          }
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "pair.request",
                "invalid_resume",
                this.resumePairMismatchMessage,
              ),
            ),
          );
          return;
        }
        const forcedPairError = this.forcedPairErrors.shift();
        if (forcedPairError) {
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "pair.request",
                forcedPairError.code,
                forcedPairError.message,
              ),
            ),
          );
          return;
        }
        const requestedSurface = this.requireSurface(String(message.payload?.surfaceId ?? this.surfaceId));
        this.pairedSocketsBySurfaceId.set(requestedSurface.surfaceId, socket);
        this.socketSurfaceIds.set(socket, requestedSurface.surfaceId);
        if (requestedSurface.surfaceId === this.surfaceId) {
          this.pairedSocket = socket;
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "pair.request", {
              capabilities: {
                contentTypes: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"],
                eventTypes: [
                  "event.annotation_committed",
                  "event.drawing_flush",
                  "event.history_navigated",
                  "event.tap",
                  "event.selection",
                  "event.page",
                  "event.navigation",
                  "event.snapshot_hint",
                ],
              },
              eventConfig: {
                activeEvents: [
                  "event.annotation_committed",
                  "event.drawing_flush",
                  "event.history_navigated",
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
                panes: [...requestedSurface.panes.entries()].map(([paneId, pane]) => ({
                  contentType: pane.contentType,
                  currentContentId: pane.contentId,
                  currentRevision: pane.revision,
                  paneId,
                  paneLabel: pane.paneLabel,
                })),
              },
              surfaceId: requestedSurface.surfaceId,
              surfaceName: requestedSurface.name,
              viewport: requestedSurface.viewport,
            }),
          ),
        );
        return;
      case "topology.apply": {
        const targetSurface = this.requirePairedSurface(socket);
        const panes = Array.isArray(message.payload?.panes)
          ? message.payload.panes.map((paneState) => ({
              name:
                typeof (paneState as { name?: unknown }).name === "string"
                  ? String((paneState as { name: string }).name)
                  : null,
              paneId: Number((paneState as { paneId?: unknown }).paneId ?? 0),
              paneLabel: Number((paneState as { paneLabel?: unknown }).paneLabel ?? 0),
            }))
          : [];
        this.topologyApplyRequests.push({
          layout: structuredClone(message.payload?.layout ?? null),
          paneIds: panes.map((pane) => pane.paneId),
          paneLabels: panes.map((pane) => pane.paneLabel),
          topologyRevision: Number(message.payload?.topologyRevision ?? 0),
          windowLabel: String(message.payload?.windowLabel ?? ""),
        });
        const previousPanes = new Map(targetSurface.panes);
        targetSurface.panes.clear();
        for (const paneState of panes) {
          const previousPane = previousPanes.get(paneState.paneId);
          targetSurface.panes.set(paneState.paneId, {
            contentId: previousPane?.contentId ?? null,
            contentType: previousPane?.contentType ?? null,
            drawings: previousPane?.drawings ? [...previousPane.drawings] : [],
            name: paneState.name,
            paneLabel: paneState.paneLabel,
            revision: previousPane?.revision ?? 0,
            viewport: previousPane?.viewport ?? { ...targetSurface.viewport },
          });
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "topology.apply", {
              panes: panes.map((pane) => ({
                name: pane.name,
                paneId: pane.paneId,
                paneLabel: pane.paneLabel,
              })),
              topologyRevision: Number(message.payload?.topologyRevision ?? 0),
            }),
          ),
        );
        return;
      }
      case "content.apply": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = targetSurface.panes.get(paneId);
        assert.ok(pane);
        if (message.payload && "clear" in message.payload) {
          pane.contentId = null;
          pane.contentType = null;
          pane.drawings = [];
          pane.revision = Number(message.payload.revision ?? pane.revision);
          this.clearRequests.push({
            paneId,
            revision: pane.revision,
          });
          socket.send(
            JSON.stringify(
              this.response(message.id, "content.apply", {
                contentId: null,
                currentContentId: null,
                currentRevision: pane.revision,
                paneId,
                topologyRevision: message.payload.topologyRevision,
              }),
            ),
          );
          return;
        }
        pane.contentId = String(message.payload?.contentId);
        pane.contentType = String(message.payload?.contentType);
        pane.revision = Number(message.payload?.revision ?? pane.revision + 1);
        pane.drawings = [];
        this.contentSetRequests.push({
          contentId: pane.contentId,
          contentType: pane.contentType,
          historyOwnerToken: String(message.payload?.historyOwnerToken ?? ""),
          paneId,
          revision: pane.revision,
        });
        socket.send(
          JSON.stringify(
            this.response(message.id, "content.apply", {
              contentId: pane.contentId,
              contentType: pane.contentType,
              currentContentId: pane.contentId,
              currentRevision: pane.revision,
              paneId,
              topologyRevision: message.payload?.topologyRevision,
            }),
          ),
        );
        return;
      }
      case "panes.list": {
        const targetSurface = this.requirePairedSurface(socket);
        socket.send(
          JSON.stringify(
            this.response(message.id, "panes.list", {
              panes: [...targetSurface.panes.entries()].map(([paneId, pane]) => ({
                activeContentId: pane.contentId,
                contentType: pane.contentType,
                name: pane.name,
                paneId,
                paneLabel: pane.paneLabel,
                viewport: pane.viewport,
              })),
            }),
          ),
        );
        return;
      }
      case "snapshot.get": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = targetSurface.panes.get(paneId);
        assert.ok(pane);
        this.snapshotRequests.push({
          includeImage: Boolean(message.payload?.includeImage),
          includeVisibleText: Boolean(message.payload?.includeVisibleText),
          paneId,
        });
        if (this.snapshotDelayMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, this.snapshotDelayMs);
          });
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "snapshot.get", {
              contentId: pane.contentId,
              contentType: pane.contentType,
              drawings: pane.drawings.map((strokeId) => ({
                points: [],
                strokeId,
              })),
              image: this.snapshotImage,
              paneId,
              revision: pane.revision,
              selection: null,
              viewport: {
                contentSize: { height: 768, width: 1024 },
                scrollOffset: { ...this.snapshotScrollOffset },
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
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = targetSurface.panes.get(paneId);
        assert.ok(pane);
        pane.contentId = String(message.payload?.contentId);
        pane.contentType = String(message.payload?.contentType);
        pane.revision = Number(message.payload?.revision ?? pane.revision + 1);
        pane.drawings = [];
        this.contentSetRequests.push({
          contentId: pane.contentId,
          contentType: pane.contentType,
          historyOwnerToken: String(message.payload?.historyOwnerToken ?? ""),
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
              paneLabel: pane.paneLabel,
            }),
          ),
        );
        return;
      }
      case "content.clear": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = targetSurface.panes.get(paneId);
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
              paneLabel: pane.paneLabel,
            }),
          ),
        );
        return;
      }
      case "pane.split": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const sourcePane = targetSurface.panes.get(paneId);
        assert.ok(sourcePane);
        if (this.dropNextSplitRequest) {
          this.dropNextSplitRequest = false;
          socket.close();
          return;
        }
        const newPaneIds = Array.isArray(message.payload?.newPaneIds)
          ? message.payload.newPaneIds.map((value) => Number(value))
          : [];
        const newPaneLabels = Array.isArray(message.payload?.newPaneLabels)
          ? message.payload.newPaneLabels.map((value) => Number(value))
          : [];
        this.splitRequests.push({
          count: Number(message.payload?.count ?? 0),
          direction: String(message.payload?.direction ?? ""),
          newPaneIds,
          newPaneLabels,
          paneId,
        });
        for (const [index, newPaneId] of newPaneIds.entries()) {
          targetSurface.panes.set(newPaneId, {
            contentId: null,
            contentType: null,
            drawings: [],
            name: null,
            paneLabel: newPaneLabels[index] ?? newPaneId,
            revision: 0,
            viewport: {
              ...sourcePane.viewport,
            },
          });
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "pane.split", {
              panes: [...targetSurface.panes.keys()].map((currentPaneId) => ({
                paneId: currentPaneId,
                paneLabel: targetSurface.panes.get(currentPaneId)?.paneLabel ?? currentPaneId,
              })),
            }),
          ),
        );
        return;
      }
      case "pane.close": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        assert.ok(targetSurface.panes.has(paneId));
        if (targetSurface.panes.size === 1) {
          socket.send(
            JSON.stringify({
              error: {
                code: "invalid_operation",
                message: "Cannot close the last remaining pane.",
              },
              id: message.id,
              ok: false,
              op: "pane.close",
              sentAt: Date.now(),
              type: "response",
              v: 1,
            }),
          );
          return;
        }
        targetSurface.panes.delete(paneId);
        this.closePaneRequests.push({ paneId });
        socket.send(
          JSON.stringify(
            this.response(message.id, "pane.close", {
              closedFramesDiscarded: 0,
              paneId,
            }),
          ),
        );
        return;
      }
      case "annotations.remove": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = targetSurface.panes.get(paneId);
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
      case "ownership.relinquish": {
        const pairedSurfaceId = this.socketSurfaceIds.get(socket);
        if (pairedSurfaceId) {
          this.pairedSocketsBySurfaceId.delete(pairedSurfaceId);
          this.socketSurfaceIds.delete(socket);
          if (pairedSurfaceId === this.surfaceId) {
            this.pairedSocket = null;
          }
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "ownership.relinquish", {
              relinquished: true,
            }),
          ),
        );
        socket.close(1000, "relinquished");
        return;
      }
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

  private errorResponse(
    id: string,
    op: string,
    code: string,
    message: string,
  ) {
    return {
      error: {
        code,
        message,
      },
      id,
      ok: false,
      op,
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

let nextPort = 22000 + Math.floor(Math.random() * 10000);

function discoveryEndpoint(port: number, fingerprintPrefix = "abcd1234"): SurfAceDiscoveryEndpoint {
  return {
    busy: false,
    capabilitiesBitmask: 31,
    endpointId: `endpoint-${port}`,
    fingerprintPrefix,
    host: "127.0.0.1",
    instanceName: "Test Surface",
    lastSeenAt: Date.now(),
    name: "Test Surface",
    port,
    protocolVersion: 1,
    viewport: { height: 768, scale: 2, width: 1024 },
    wsPath: "/ws",
  };
}

async function withRuntimeHarness(
  optionsOrRun:
    | ((
        ctx: {
          alertBodies: Array<Record<string, unknown>>;
          annotationTurns: import("./surf-ace-runtime.js").SurfAceAnnotationIntentTurn[];
          discovery: StaticDiscoveryService;
          warnings: string[];
          runtime: ReturnType<typeof createSurfAceRuntime>;
          server: FakeSurfAceWsServer;
        },
      ) => Promise<void>)
    | {
        now?: () => number;
        providerName?: string;
        run: (ctx: {
          alertBodies: Array<Record<string, unknown>>;
          annotationTurns: import("./surf-ace-runtime.js").SurfAceAnnotationIntentTurn[];
          discovery: StaticDiscoveryService;
          warnings: string[];
          runtime: ReturnType<typeof createSurfAceRuntime>;
          server: FakeSurfAceWsServer;
        }) => Promise<void>;
      },
): Promise<void> {
  const options =
    typeof optionsOrRun === "function"
      ? { run: optionsOrRun, now: undefined, providerName: undefined }
      : optionsOrRun;
  const port = nextPort++;
  const server = new FakeSurfAceWsServer(port);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-"));
  const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
  const warnings: string[] = [];
  const annotationTurns: import("./surf-ace-runtime.js").SurfAceAnnotationIntentTurn[] = [];
  const runtime = createSurfAceRuntime({
    deliverSettledAnnotationTurn: async (turn) => {
      annotationTurns.push(structuredClone(turn));
    },
    discovery,
    logger: {
      warn: (message: string) => {
        warnings.push(message);
      },
    },
    now: options.now,
    providerName: options.providerName,
    stateDir,
  });
  const alertBodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (_input, init) => {
      alertBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await runtime.start();
    await waitFor(() => server.pairedSocket !== null);
    await options.run({ alertBodies, annotationTurns, discovery, runtime, server, warnings });
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.stop();
    await server.close();
    await fs.rm(stateDir, { force: true, recursive: true });
  }
}

function assertAnnotationAlertBody(
  body: Record<string, unknown>,
  params: {
    image: string;
    message: string;
    paneId: string | number;
    sessionKey: string;
    surfaceId: string;
  },
): void {
  assert.equal(body.message, params.message);
  assert.equal(body.noOverlay, true);
  assert.equal(body.sessionKey, params.sessionKey);
  assert.ok(Array.isArray(body.attachments));
  assert.equal(body.attachments.length, 1);
  const [attachment] = body.attachments as Array<Record<string, unknown>>;
  assert.equal(attachment.type, "file");
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(attachment.content, params.image);
  assert.equal(typeof attachment.fileName, "string");
  assert.match(
    String(attachment.fileName),
    new RegExp(`^surf-ace-${params.surfaceId}-pane-${params.paneId}-.+\\.png$`),
  );
}

function assertOpaquePaneId(paneId: unknown): asserts paneId is string {
  assert.equal(typeof paneId, "string");
  assert.match(paneId, /^pn_[0-9a-f]{32}$/);
}

function paneByLabel(
  screen: { panes: Array<{ paneId: string; paneLabel: number }> } | undefined,
  paneLabel: number,
): { paneId: string; paneLabel: number } {
  assert.ok(screen);
  const pane = screen.panes.find((candidate) => candidate.paneLabel === paneLabel);
  assert.ok(pane);
  assertOpaquePaneId(pane.paneId);
  return pane;
}

async function livePaneId(
  runtime: ReturnType<typeof createSurfAceRuntime>,
  fingerprint: string,
  paneLabel: number,
): Promise<string> {
  const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === fingerprint);
  return paneByLabel(screen, paneLabel).paneId;
}

function assertPaneLabelsWithOpaqueIds(
  panes: Array<{ paneId: string; paneLabel: number }>,
  expectedPaneLabels: number[],
): string[] {
  const paneIds = panes.map((pane) => {
    assertOpaquePaneId(pane.paneId);
    return pane.paneId;
  });
  assert.deepEqual(panes.map((pane) => pane.paneLabel), expectedPaneLabels);
  assert.equal(new Set(paneIds).size, paneIds.length);
  return paneIds;
}

test("surf ace runtime enforces spec-aligned provider behavior", async (t) => {
  await t.test("passive processes read the active owner's shared screen snapshot", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-lease-"));
    const discoveryA = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const discoveryB = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const infoMessagesA: string[] = [];
    const infoMessagesB: string[] = [];
    const runtimeA = createSurfAceRuntime({
      discovery: discoveryA,
      logger: {
        info: (message: string) => {
          infoMessagesA.push(message);
        },
      },
      stateDir,
    });
    const runtimeB = createSurfAceRuntime({
      discovery: discoveryB,
      logger: {
        info: (message: string) => {
          infoMessagesB.push(message);
        },
      },
      stateDir,
    });

    try {
      await runtimeA.start();
      await waitFor(() => server.pairedSocket !== null);
      await runtimeB.start();
      await waitFor(async () => (await runtimeB.listScreens()).length === 1);

      const screensA = await runtimeA.listScreens();
      const screensB = await runtimeB.listScreens();
      assert.equal(server.pairRequests.length, 1);
      assert.equal(screensA[0]?.connectionState, "connected");
      assert.equal(screensB[0]?.connectionState, "connected");
      assert.equal(screensB[0]?.fingerprint, screensA[0]?.fingerprint);
      assert.equal(screensB[0]?.windowLabel, screensA[0]?.windowLabel);
      assert.ok(
        infoMessagesB.some((message) => message.includes("passive process")),
      );
    } finally {
      await runtimeB.stop();
      await runtimeA.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("passive processes migrate persisted numeric pane ids to opaque pane ids", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-lease-"));
    const discoveryA = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const discoveryB = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtimeA = createSurfAceRuntime({ discovery: discoveryA, stateDir });
    const runtimeB = createSurfAceRuntime({ discovery: discoveryB, stateDir });

    try {
      await runtimeA.start();
      await waitFor(() => server.pairedSocket !== null);
      const activeScreens = await runtimeA.listScreens();
      const activeScreen = activeScreens[0];
      assert.ok(activeScreen);

      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            screens: [
              {
                ...activeScreen,
                panes: activeScreen.panes.map((pane) => ({
                  ...pane,
                  paneId: 1,
                })),
              },
            ],
            updatedAt: Date.now(),
            version: 1,
          },
          null,
          2,
        ),
      );

      await runtimeB.start();
      const passiveScreens = await runtimeB.listScreens();
      const passivePaneId = passiveScreens[0]?.panes[0]?.paneId;
      assertOpaquePaneId(passivePaneId);
      assert.equal(passiveScreens[0]?.panes[0]?.paneLabel, 1);
    } finally {
      await runtimeB.stop();
      await runtimeA.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("listScreens exposes only the CLU surface fields and local pane identities", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const screens = await runtime.listScreens();
      assert.equal(screens.length, 1);

      const screen = screens[0];
      assert.ok(screen);
      assert.deepEqual(
        Object.keys(screen).sort(),
        [
          "_debug",
          "connectionState",
          "fingerprint",
          "lastSeenAt",
          "name",
          "panes",
          "pendingEvents",
          "viewport",
          "windowLabel",
        ].sort(),
      );
      assert.equal(screen.fingerprint, server.surfaceId);
      assert.equal(screen.windowLabel, "a");
      assertPaneLabelsWithOpaqueIds(screen.panes, [1]);
      assert.equal(server.initialRemotePaneId, 41);
      assert.deepEqual(
        Object.keys(screen.panes[0] ?? {}).sort(),
        ["activeContent", "historySummary", "name", "paneId", "paneLabel"].sort(),
      );
    });
  });

  await t.test("previously unseen remote panes seed paneLabel from remotePaneId once during migration", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      server.panes.set(77, {
        contentId: null,
        contentType: null,
        drawings: [],
        name: null,
        paneLabel: 77,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      });

      await internalRuntime.syncSurfaceSnapshots(surface, true);
      const screens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 77]);
    });
  });

  await t.test("migration-seeded pane labels advance the allocator before later splits", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      server.panes.set(2, {
        contentId: null,
        contentType: null,
        drawings: [],
        name: null,
        paneLabel: 2,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      });

      await internalRuntime.syncSurfaceSnapshots(surface, true);
      await waitFor(async () => (await runtime.listScreens())[0]?.panes.length === 2, 12_000);
      const sourcePaneId = await livePaneId(runtime, server.surfaceId, 1);

      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: sourcePaneId,
      });

      assert.deepEqual(server.splitRequests.at(-1), {
        count: 2,
        direction: "horizontal",
        newPaneIds: [42],
        newPaneLabels: [3],
        paneId: server.initialRemotePaneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);
    });
  });

  await t.test("multiple surfaces get unique window labels and globally unique first pane ids", async () => {
    const portA = nextPort++;
    const portB = nextPort++;
    const serverA = new FakeSurfAceWsServer(portA, { surfaceId: "sf_surface-a" });
    const serverB = new FakeSurfAceWsServer(portB, { surfaceId: "sf_surface-b" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-multi-"));
    const discovery = new StaticDiscoveryService([
      discoveryEndpoint(portA, "aaaabbbb"),
      discoveryEndpoint(portB, "ccccdddd"),
    ]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => serverA.pairedSocket !== null && serverB.pairedSocket !== null);

      const screens = await runtime.listScreens();
      const firstPaneIds = screens.map((screen) => {
        const paneId = screen.panes[0]?.paneId;
        assertOpaquePaneId(paneId);
        return paneId;
      });
      assert.deepEqual(
        screens.map((screen) => ({
          panes: screen.panes.map((pane) => pane.paneLabel),
          windowLabel: screen.windowLabel,
        })),
        [
          { panes: [1], windowLabel: "a" },
          { panes: [2], windowLabel: "b" },
        ],
      );
      assert.equal(new Set(firstPaneIds).size, firstPaneIds.length);
      assert.equal(serverA.pairRequests[0]?.windowLabel, "a");
      assert.equal(serverB.pairRequests[0]?.windowLabel, "b");
      assert.deepEqual(
        [serverA.pairRequests[0]?.initialPaneId, serverB.pairRequests[0]?.initialPaneId].sort(),
        [1, 2],
      );
      assert.deepEqual(
        [serverA.pairRequests[0]?.initialPaneLabel, serverB.pairRequests[0]?.initialPaneLabel].sort(),
        [1, 2],
      );
    } finally {
      await runtime.stop();
      await serverB.close();
      await serverA.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("surfaces.list binds and pairs every surface exposed by one endpoint", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
    server.addSurface({ initialRemotePaneId: 43, name: "Surface C", surfaceId: "sf_surface-c" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-multi-surface-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() =>
        server.pairedSocketFor("sf_surface-a") !== null &&
        server.pairedSocketFor("sf_surface-b") !== null &&
        server.pairedSocketFor("sf_surface-c") !== null,
      );

      const screens = await runtime.listScreens();
      const paneIds = screens.flatMap((screen) => screen.panes.map((pane) => pane.paneId));
      for (const paneId of paneIds) {
        assertOpaquePaneId(paneId);
      }
      assert.equal(new Set(paneIds).size, paneIds.length);
      assert.deepEqual(
        screens.map((screen) => ({
          fingerprint: screen.fingerprint,
          panes: screen.panes.map((pane) => pane.paneLabel),
          windowLabel: screen.windowLabel,
        })),
        [
          { fingerprint: "sf_surface-a", panes: [1], windowLabel: "a" },
          { fingerprint: "sf_surface-b", panes: [2], windowLabel: "b" },
          { fingerprint: "sf_surface-c", panes: [3], windowLabel: "c" },
        ],
      );

      const requestsBySurface = new Map(
        server.pairRequestSurfaceIds.map((surfaceId, index) => [surfaceId, server.pairRequests[index]]),
      );
      assert.deepEqual([...requestsBySurface.keys()].sort(), [
        "sf_surface-a",
        "sf_surface-b",
        "sf_surface-c",
      ]);
      assert.equal(requestsBySurface.get("sf_surface-a")?.windowLabel, "a");
      assert.equal(requestsBySurface.get("sf_surface-b")?.windowLabel, "b");
      assert.equal(requestsBySurface.get("sf_surface-c")?.windowLabel, "c");
      assert.deepEqual(
        [...requestsBySurface.values()].map((request) => request?.initialPaneId).sort(),
        [1, 42, 43],
      );
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("surfaces.list does not remap an established missing surface to the first sibling", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });

      const internalRuntime = runtime as any;
      const preservedSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(preservedSurface);
      const staleSurface = {
        ...preservedSurface,
        client: {
          isOpen: () => true,
          request: async () => ({
            id: "rq_surfaces_list",
            ok: true,
            op: "surfaces.list",
            payload: {
              surfaces: [
                {
                  name: "Surface A",
                  paired: true,
                  surfaceId: server.surfaceId,
                  viewport: preservedSurface.viewport,
                },
                {
                  name: "Surface B",
                  paired: false,
                  surfaceId: "sf_surface-b",
                  viewport: preservedSurface.viewport,
                },
              ],
            },
            sentAt: Date.now(),
            type: "response",
            v: 1,
          }),
        },
        connectedAt: null,
        hasPairedInGatewaySession: false,
        panes: new Map(),
        recentEventIds: [],
        recentEventIdsSet: new Set(),
        retryDelayResolver: null,
        sessionId: null,
        snapshotBufferedEvents: [],
        stopRequested: false,
        surfaceId: "sf_stale-window" as any,
        workPromise: null,
      };
      internalRuntime.surfaces.set(staleSurface.surfaceId, staleSurface);

      await internalRuntime.discoverSurfaceId(staleSurface);

      assert.equal(staleSurface.surfaceId, "sf_stale-window");
      assert.equal(internalRuntime.surfaces.get("sf_stale-window"), staleSurface);
      assert.equal(internalRuntime.surfaces.get(server.surfaceId), preservedSurface);
      assert.ok(internalRuntime.surfaces.get("sf_surface-b"));
    });
  });

  await t.test("endpoint reconciliation updates every known surface on a multi-window endpoint", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
    server.addSurface({ initialRemotePaneId: 43, name: "Surface C", surfaceId: "sf_surface-c" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-multi-reconcile-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port, "aaaabbbb")]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() =>
        server.pairedSocketFor("sf_surface-a") !== null &&
        server.pairedSocketFor("sf_surface-b") !== null &&
        server.pairedSocketFor("sf_surface-c") !== null,
      );

      const internalRuntime = runtime as any;
      const replacementEndpoint = {
        ...discoveryEndpoint(nextPort++, "aaaabbbb"),
        endpointId: "endpoint-replacement",
      };
      internalRuntime.refreshEndpointTopology(replacementEndpoint);

      for (const surfaceId of ["sf_surface-a", "sf_surface-b", "sf_surface-c"]) {
        const surface = internalRuntime.surfaces.get(surfaceId);
        assert.ok(surface);
        assert.equal(surface.endpointId, "endpoint-replacement");
      }
      assert.deepEqual(
        [...internalRuntime.surfaces.keys()].filter((surfaceId) => surfaceId.startsWith("sf_surface-")).sort(),
        ["sf_surface-a", "sf_surface-b", "sf_surface-c"],
      );
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("surface appeared and removed events add and drop live surfaces on one endpoint", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-surface-events-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => server.pairedSocket !== null);

      server.sendSurfaceAppeared({
        initialRemotePaneId: 42,
        name: "Surface B",
        surfaceId: "sf_surface-b",
      });

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          server.pairedSocketFor("sf_surface-b") !== null &&
          screens.some((screen) => screen.fingerprint === "sf_surface-b")
        );
      });

      assert.deepEqual(
        (await runtime.listScreens()).map((screen) => screen.fingerprint),
        ["sf_surface-a", "sf_surface-b"],
      );

      server.sendSurfaceRemoved({ surfaceId: "sf_surface-b" });

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          server.pairedSocketFor("sf_surface-b") === null &&
          !screens.some((screen) => screen.fingerprint === "sf_surface-b")
        );
      });

      assert.deepEqual(
        (await runtime.listScreens()).map((screen) => screen.fingerprint),
        ["sf_surface-a"],
      );
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("provider keeps pane identity local and reuses content ownership per injected session", async () => {
    await withRuntimeHarness(async ({ alertBodies, runtime, server }) => {
      const localEvents: Array<{
        paneId: string;
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
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const first = await runtime.push(
          {
            content: "<p>first</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          { sessionKey: "agent:test:1" },
        );
        const second = await runtime.push(
          {
            content: "<p>second</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          { sessionKey: "agent:test:1" },
        );
        const third = await runtime.push(
          {
            content: "<p>third</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          { sessionKey: "agent:test:2" },
        );

        assert.equal(server.contentSetRequests.length, 3);
        assert.deepEqual(server.pairRequests, [
          {
            initialPaneId: 1,
            initialPaneLabel: 1,
            windowLabel: "a",
          },
        ]);
        assert.deepEqual(
          server.contentSetRequests.map((request) => request.paneId),
          [server.initialRemotePaneId, server.initialRemotePaneId, server.initialRemotePaneId],
        );
        assert.ok(server.contentSetRequests.every((request) => request.historyOwnerToken.startsWith("hot_")));
        assert.equal(
          server.contentSetRequests[0]?.historyOwnerToken,
          server.contentSetRequests[1]?.historyOwnerToken,
        );
        assert.notEqual(
          server.contentSetRequests[0]?.historyOwnerToken,
          server.contentSetRequests[2]?.historyOwnerToken,
        );
        assert.equal(first.paneId, firstPaneId);
        assert.equal(second.paneId, firstPaneId);
        assert.equal(third.paneId, firstPaneId);
        assert.equal(first.contentId, second.contentId);
        assert.notEqual(first.contentId, third.contentId);
        assert.deepEqual(localEvents, [
          {
            paneId: firstPaneId,
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
        assertAnnotationAlertBody(alertBodies[0], {
          image: "aGVsbG8=",
          message: "Surf Ace updates pending on Surface A (1 live dirty stroke)",
          paneId: firstPaneId,
          sessionKey: "agent:test:2",
          surfaceId: server.surfaceId,
        });

        server.sendDrawingFlush(server.initialRemotePaneId, third.contentId);
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        assert.equal(alertBodies.length, 1);

        const read = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.ok(read.liveDirtyStrokeIds.includes("stroke_abc123"));
        assert.equal(read.liveFrame?.contentId, third.contentId);
        assert.equal(read.liveFrame?.contextKey, third.contentId);
        assert.deepEqual(read.liveFrame?.strokes[0]?.points[0], {
          pressure: 0.2,
          x: 10,
          y: 20,
        });

        server.sendDrawingFlush(server.initialRemotePaneId, third.contentId);
        await waitFor(() => alertBodies.length === 2);

        const removed = await runtime.annotateRemove({
          contentId: third.contentId,
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
          strokeIds: ["stroke_abc123"],
        });
        assert.deepEqual(removed, {
          fingerprint: server.surfaceId,
          notFoundStrokeIds: [],
          paneId: firstPaneId,
          paneLabel: 1,
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
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const markdownPush = await runtime.push(
        {
          content: "# notes",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:1" },
      );

      server.sendNavigation(server.initialRemotePaneId, markdownPush.contentId, "https://example.com/ignored");
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const markdownRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(markdownRead.lastNavigation, null);

      const htmlPush = await runtime.push(
        {
          content: "<p>html</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
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

      const htmlRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.deepEqual(htmlRead.lastNavigation, {
        navigatedAt,
        url: "https://example.com/live",
      });

      const clear = await runtime.clear({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.deepEqual(clear, {
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
        paneLabel: 1,
        revision: clear.revision,
      });
      assert.deepEqual(server.clearRequests.map((request) => request.paneId), [server.initialRemotePaneId]);
    });
  });

  await t.test("provider splits panes with provider-assigned pane ids and closes them by pane scope", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      const splitPaneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);
      assert.deepEqual(server.splitRequests, []);
      assert.deepEqual(server.topologyApplyRequests.slice(0, 1), [
        {
          layout: {
            children: [
              { paneId: server.initialRemotePaneId, type: "pane" },
              { paneId: 42, type: "pane" },
              { paneId: 43, type: "pane" },
            ],
            direction: "horizontal",
            type: "split",
          },
          paneIds: [server.initialRemotePaneId, 42, 43],
          paneLabels: [1, 2, 3],
          topologyRevision: 1,
          windowLabel: "a",
        },
      ]);

      const splitScreens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(splitScreens[0]?.panes ?? [], [1, 2, 3]);

      const close = await runtime.closePane({
        fingerprint: server.surfaceId,
        paneId: splitPaneIds[1]!,
      });
      assert.deepEqual(close, { ok: true, paneId: splitPaneIds[1], paneLabel: 2 });
      assert.deepEqual(server.closePaneRequests, []);
      assert.deepEqual(server.topologyApplyRequests.at(-1), {
        layout: {
          children: [
            { paneId: server.initialRemotePaneId, type: "pane" },
            { paneId: 43, type: "pane" },
          ],
          direction: "horizontal",
          type: "split",
        },
        paneIds: [server.initialRemotePaneId, 43],
        paneLabels: [1, 3],
        topologyRevision: 2,
        windowLabel: "a",
      });

      const afterCloseScreens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(afterCloseScreens[0]?.panes ?? [], [1, 3]);
    });
  });

  await t.test("extension-owned topology is re-applied after reconnect instead of importing collapsed surface panes", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const splitPaneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);

      const firstPush = await runtime.push(
        {
          content: "<p>one</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: splitPaneIds[0]!,
        },
        { sessionKey: "agent:test:topology-a" },
      );
      const secondPush = await runtime.push(
        {
          content: "<p>two</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: splitPaneIds[1]!,
        },
        { sessionKey: "agent:test:topology-b" },
      );

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      server.panes.clear();
      server.panes.set(server.initialRemotePaneId, {
        contentId: null,
        contentType: null,
        drawings: [],
        name: null,
        paneLabel: 1,
        revision: 0,
        viewport: { height: 768, scale: 2, width: 1024 },
      });

      const initialTopologyApplyCount = server.topologyApplyRequests.length;
      const initialContentApplyCount = server.contentSetRequests.length;
      await surface.client.close(1000, "test_authoritative_topology_reconnect");

      await waitFor(() => server.pairRequests.length >= 2, 12_000);
      await waitFor(() => server.topologyApplyRequests.length > initialTopologyApplyCount, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      const lastTopologyApply = server.topologyApplyRequests.at(-1);
      assert.deepEqual(lastTopologyApply?.paneLabels, [1, 2, 3]);
      assert.deepEqual(lastTopologyApply?.paneIds, [server.initialRemotePaneId, 42, 43]);

      await waitFor(() => server.contentSetRequests.length >= initialContentApplyCount + 2, 12_000);
      const repushedContentIds = server.contentSetRequests.slice(-2).map((request) => request.contentId);
      assert.deepEqual(repushedContentIds.sort(), [firstPush.contentId, secondPush.contentId].sort());

      const screens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 2, 3]);
      assert.equal(screens[0]?.panes[0]?.activeContent?.contentId, firstPush.contentId);
      assert.equal(screens[0]?.panes[1]?.activeContent?.contentId, secondPush.contentId);
    });
  });

  await t.test("history navigation updates provider-owned visible content for reconnect repush", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const first = await runtime.push(
        {
          content: "<p>first</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:history-a" },
      );
      const second = await runtime.push(
        {
          content: "<p>second</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:history-b" },
      );

      server.sendHistoryNavigated(server.initialRemotePaneId, {
        contentId: first.contentId,
        direction: "back",
        revision: 1,
      });

      await waitFor(async () => (await runtime.listScreens())[0]?.panes[0]?.historySummary.visibleContentId === first.contentId);

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      const initialContentApplyCount = server.contentSetRequests.length;
      await surface.client.close(1000, "test_history_repush_reconnect");

      await waitFor(() => server.pairRequests.length >= 2, 12_000);
      await waitFor(() => server.contentSetRequests.length > initialContentApplyCount, 12_000);

      const repushed = server.contentSetRequests.at(-1);
      assert.equal(repushed?.contentId, first.contentId);
      assert.notEqual(repushed?.contentId, second.contentId);

      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.activeContent?.contentId, first.contentId);
      assert.equal(screens[0]?.panes[0]?.historySummary.visibleContentId, first.contentId);
    });
  });

  await t.test("provider rejects invalid split counts and cleans reserved panes after split transport failure", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await assert.rejects(
        runtime.split({
          count: 1,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        }),
        /at least 2/,
      );

      server.dropNextSplitRequest = true;
      await assert.rejects(
        runtime.split({
          count: 3,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        }),
      );

      const screens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1]);
    });
  });

  await t.test("provider captures frame-open state freshly, delivers settled annotation turns, and ignores after_reconnect snapshot hints", async () => {
    await withRuntimeHarness(async ({ alertBodies, annotationTurns, runtime, server, warnings }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "<p>fresh snapshot</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:fresh" },
      );

      const initialSnapshotCount = server.snapshotRequests.length;
      server.snapshotImage = "ZnJhbWUtb3Blbg==";
      server.snapshotScrollOffset = { x: 24, y: 48 };
      server.sendDrawingFlush(server.initialRemotePaneId, pushed.contentId);

      await waitFor(() => server.snapshotRequests.length > initialSnapshotCount);
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const liveRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(liveRead.liveFrame?.image, "ZnJhbWUtb3Blbg==");
      assert.deepEqual(liveRead.liveFrame?.scrollOffset, { x: 24, y: 48 });
      assertAnnotationAlertBody(alertBodies[0], {
        image: "ZnJhbWUtb3Blbg==",
        message: "Surf Ace updates pending on Surface A (1 live dirty stroke)",
        paneId: firstPaneId,
        sessionKey: "agent:test:fresh",
        surfaceId: server.surfaceId,
      });

      const clear = await runtime.clear({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(clear.paneId, firstPaneId);
      await waitFor(() => annotationTurns.length === 1);
      assert.equal(alertBodies.length, 1);
      const turn = annotationTurns[0];
      assert.ok(turn);
      assert.equal(turn.fingerprint, server.surfaceId);
      assert.equal(turn.paneId, firstPaneId);
      assert.equal(turn.sessionKey, "agent:test:fresh");
      assert.equal(turn.surfaceName, "Surface A");
      assert.equal(turn.attachment.content, "ZnJhbWUtb3Blbg==");
      assert.equal(turn.attachment.mimeType, "image/png");
      assert.equal(turn.attachment.type, "file");
      assert.equal(
        turn.attachment.fileName,
        `surf-ace-${server.surfaceId}-pane-${firstPaneId}-${turn.frame.frameId}.png`,
      );
      assert.equal(turn.frame.contentId, pushed.contentId);
      assert.equal(turn.frame.contextKey, pushed.contentId);
      assert.equal(turn.frame.image, "ZnJhbWUtb3Blbg==");
      assert.deepEqual(turn.frame.scrollOffset, { x: 24, y: 48 });
      assert.deepEqual(turn.frame.viewport, {
        height: 768,
        scale: 2,
        width: 1024,
      });
      assert.equal(turn.frame.url, undefined);
      assert.deepEqual(turn.frame.strokes, [
        {
          bbox: { height: 20, width: 20, x: 10, y: 20 },
          endedAt: 120,
          points: [
            { pressure: 0.2, x: 10, y: 20 },
            { pressure: 0.4, x: 30, y: 40 },
          ],
          startedAt: 100,
          strokeId: "stroke_abc123",
        },
      ]);
      assert.equal(
        turn.idempotencyKey,
        `surf-ace-annotation-intent:${server.surfaceId}:${firstPaneId}:${turn.frame.frameId}`,
      );
      assert.match(turn.message, /Treat the attached image as the primary annotation input\./);
      assert.match(turn.message, /Use the stroke metadata below as secondary context only\./);

      const closedRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(closedRead.frames.length, 1);

      const beforeReconnectHint = server.snapshotRequests.length;
      server.sendSnapshotHint("after_reconnect");
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      assert.equal(server.snapshotRequests.length, beforeReconnectHint);

      server.sendSnapshotHint("after_render");
      await waitFor(() => server.snapshotRequests.length > beforeReconnectHint);

      server.snapshotDelayMs = 250;
      server.sendSnapshotHint("after_render");
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
      for (let index = 0; index <= 128; index += 1) {
        server.sendDrawingFlush(server.initialRemotePaneId, pushed.contentId);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      server.snapshotDelayMs = 0;

      assert.ok(
        warnings.some((warning) => warning.includes("snapshot event buffer overflow")),
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
    });
  });

  await t.test("annotation committed finalizes live annotation frames without a pane mutation", async () => {
    await withRuntimeHarness(async ({ annotationTurns, runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "<p>annotation committed</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:annotation-committed" },
      );

      server.snapshotImage = "Y29tbWl0dGVkLWZyYW1l";
      server.sendDrawingFlush(server.initialRemotePaneId, pushed.contentId);
      server.sendAnnotationCommitted(server.initialRemotePaneId, pushed.contentId);

      await waitFor(() => annotationTurns.length === 1);
      const turn = annotationTurns[0];
      assert.ok(turn);
      assert.equal(turn.sessionKey, "agent:test:annotation-committed");
      assert.equal(turn.attachment.content, "Y29tbWl0dGVkLWZyYW1l");
      assert.equal(turn.frame.contentId, pushed.contentId);

      const read = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(read.liveFrame, null);
      assert.equal(read.frames.length, 1);
      assert.equal(read.frames[0]?.image, "Y29tbWl0dGVkLWZyYW1l");
    });
  });

  await t.test("provider leaves settled annotation frames queued when the snapshot image is missing", async () => {
    await withRuntimeHarness(async ({ alertBodies, annotationTurns, runtime, server, warnings }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "<p>missing image</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:missing-image" },
      );

      const initialSnapshotCount = server.snapshotRequests.length;
      server.snapshotImage = "";
      server.sendDrawingFlush(server.initialRemotePaneId, pushed.contentId);

      await waitFor(() => server.snapshotRequests.length > initialSnapshotCount);
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const clear = await runtime.clear({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(clear.paneId, firstPaneId);
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      assert.equal(alertBodies[0]?.attachments, undefined);
      assert.equal(
        alertBodies[0]?.message,
        "Surf Ace updates pending on Surface A (1 live dirty stroke)",
      );
      assert.equal(alertBodies[0]?.noOverlay, true);
      assert.equal(alertBodies[0]?.sessionKey, "agent:test:missing-image");
      assert.equal(annotationTurns.length, 0);
      const closedRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(closedRead.frames.length, 1);
      assert.equal(closedRead.frames[0]?.image, "");
      assert.ok(
        warnings.some((warning) => warning.includes("settled annotation frame missing image")),
      );
    });
  });

  await t.test("reconnect snapshot materializes visible pane drawings back into surf_ace_read", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "<p>reconnect state</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:reconnect" },
      );

      const pane = server.panes.get(server.initialRemotePaneId);
      assert.ok(pane);
      pane.drawings = ["stroke_recovered"];
      server.snapshotImage = "cmVjb25uZWN0LWZyYW1l";
      server.snapshotScrollOffset = { x: 12, y: 34 };

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      await surface.client.close(1000, "test_reconnect_snapshot_materialization");

      await waitFor(() => server.pairRequests.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      const recovered = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(recovered.liveFrame?.contentId, pushed.contentId);
      assert.equal(recovered.liveFrame?.image, "cmVjb25uZWN0LWZyYW1l");
      assert.deepEqual(recovered.liveFrame?.scrollOffset, { x: 12, y: 34 });
      assert.deepEqual(recovered.liveFrame?.strokes.map((stroke) => stroke.strokeId), [
        "stroke_recovered",
      ]);
      assert.deepEqual(recovered.liveDirtyStrokeIds, ["stroke_recovered"]);

      const afterRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.deepEqual(afterRead.liveFrame?.strokes.map((stroke) => stroke.strokeId), [
        "stroke_recovered",
      ]);
      assert.deepEqual(afterRead.liveDirtyStrokeIds, []);
    });
  });

  await t.test("annotation alert gate is surface-scoped and resets on read or timeout", async () => {
    let currentTime = Date.now();
    await withRuntimeHarness({
      now: () => currentTime,
      run: async ({ alertBodies, runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const firstPush = await runtime.push(
          {
            content: "<p>pane one</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          { sessionKey: "agent:test:alert-1" },
        );

        server.sendDrawingFlush(server.initialRemotePaneId, firstPush.contentId);
        await waitFor(() => alertBodies.length === 1);
        assertAnnotationAlertBody(alertBodies[0], {
          image: "aGVsbG8=",
          message: "Surf Ace updates pending on Surface A (1 live dirty stroke)",
          paneId: firstPaneId,
          sessionKey: "agent:test:alert-1",
          surfaceId: server.surfaceId,
        });

        const split = await runtime.split({
          count: 2,
          direction: "horizontal",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        const splitPaneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);

        const secondRemotePaneId = server.splitRequests.at(-1)?.newPaneIds[0];
        assert.equal(typeof secondRemotePaneId, "number");

        const secondPush = await runtime.push(
          {
            content: "<p>pane two</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: splitPaneIds[1]!,
          },
          { sessionKey: "agent:test:alert-2" },
        );

        server.sendDrawingFlush(secondRemotePaneId as number, secondPush.contentId);
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        assert.equal(alertBodies.length, 1);

        currentTime += 10 * 60_000 + 1;
        server.sendDrawingFlush(secondRemotePaneId as number, secondPush.contentId);
        await waitFor(() => alertBodies.length === 2);
        assertAnnotationAlertBody(alertBodies[1], {
          image: "aGVsbG8=",
          message: "Surf Ace updates pending on Surface A (3 live dirty strokes)",
          paneId: splitPaneIds[1]!,
          sessionKey: "agent:test:alert-2",
          surfaceId: server.surfaceId,
        });

        await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });

        server.sendDrawingFlush(secondRemotePaneId as number, secondPush.contentId);
        await waitFor(() => alertBodies.length === 3);
        assertAnnotationAlertBody(alertBodies[2], {
          image: "aGVsbG8=",
          message: "Surf Ace updates pending on Surface A (3 live dirty strokes)",
          paneId: splitPaneIds[1]!,
          sessionKey: "agent:test:alert-2",
          surfaceId: server.surfaceId,
        });
      },
    });
  });

  await t.test("background resume sync bails on closed sockets without unhandled rejections", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      const unhandled: unknown[] = [];
      const handleUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", handleUnhandled);

      try {
        await surface.client.close(1000, "test_close");
        internalRuntime.handleSurfaceResumedEvent(surface, {
          eventId: "ev_test_resume",
          op: "event.surface_resumed",
          payload: {
            surfaceId: server.surfaceId,
          },
          sentAt: Date.now(),
          type: "event",
          v: 1,
        });

        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });

        assert.deepEqual(unhandled, []);
        assert.equal(
          warnings.some((warning) => warning.includes("Surf Ace socket is not open")),
          false,
        );
      } finally {
        process.off("unhandledRejection", handleUnhandled);
      }
    });
  });

  await t.test("worker closes stale sockets before retrying failed pair attempts", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    server.forcedPairErrors = [
      {
        code: "invalid_resume",
        message: "Resume session did not match active ownership lock",
      },
      {
        code: "invalid_resume",
        message: "Resume session did not match active ownership lock",
      },
      {
        code: "invalid_resume",
        message: "Resume session did not match active ownership lock",
      },
    ];

    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-retry-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({
      discovery,
      logger: {
        warn: () => {},
      },
      stateDir,
    });

    try {
      await runtime.start();
      await waitFor(() => server.pairRequests.length >= 3, 12_000);
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      assert.ok(server.activeSocketCount <= 1);
      assert.ok(server.maxConcurrentSocketCount <= 1);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }

    assert.equal(server.activeSocketCount, 0);
  });

  await t.test("rediscovery on an already paired surface does not re-arm takeover from paired advertisement", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.equal(surface.sessionId, "sa_test_session");
      assert.equal(surface.hasPairedInGatewaySession, true);

      surface.forceTakeoverOnNextPair = false;
      await internalRuntime.discoverSurfaceId(surface);

      assert.equal(surface.forceTakeoverOnNextPair, false);
    });
  });

  await t.test("rediscovery after resume fallback does not re-arm takeover from paired advertisement", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.equal(surface.sessionId, "sa_test_session");
      assert.equal(surface.hasPairedInGatewaySession, true);

      surface.sessionId = null;
      surface.forceTakeoverOnNextPair = false;
      await internalRuntime.discoverSurfaceId(surface);

      assert.equal(surface.forceTakeoverOnNextPair, false);
    });
  });

  await t.test("discovery churn does not close an already connected surface", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server }) => {
      const initialPairAttempts = server.pairAttemptDetails.length;
      assert.equal(initialPairAttempts, 1);

      discovery.setEndpoints([]);
      await discovery.refreshNow();
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.connectionState, "connected");
      assert.equal(server.pairAttemptDetails.length, initialPairAttempts);
      assert.notEqual(server.pairedSocket, null);
    });
  });

  await t.test("discovery churn does not cull a previously paired disconnected surface", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      await surface.client.close(1000, "test_discovery_gap_after_drop");
      await waitFor(async () => {
        const screen = (await runtime.listScreens()).find((entry) => entry.fingerprint === server.surfaceId);
        return screen ? screen.connectionState !== "connected" : false;
      }, 12_000);

      discovery.setEndpoints([]);
      await discovery.refreshNow();
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const screen = (await runtime.listScreens()).find((entry) => entry.fingerprint === server.surfaceId);
      assert.ok(screen);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1]);
      assert.equal(surface.stopRequested, false);
    });
  });

  await t.test("brief reconnects preserve backoff until a connection has been stable for 30s", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      surface.reconnectAttempt = 4;
      surface.unreachableFailures = 2;
      surface.connectedAt = Date.now() - 5_000;
      internalRuntime.noteConnectionEnded(surface);
      assert.equal(surface.reconnectAttempt, 4);
      assert.equal(surface.unreachableFailures, 2);

      surface.reconnectAttempt = 4;
      surface.unreachableFailures = 2;
      surface.connectedAt = Date.now() - 31_000;
      internalRuntime.noteConnectionEnded(surface);
      assert.equal(surface.reconnectAttempt, 0);
      assert.equal(surface.unreachableFailures, 0);
    });
  });

  await t.test("resume failures keep the owner session state intact", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      surface.reconnectAttempt = 3;
      internalRuntime.noteResumeFailure(surface);
      internalRuntime.noteResumeFailure(surface);
      internalRuntime.noteResumeFailure(surface);
      assert.equal(surface.reconnectAttempt, 3);
      assert.equal(surface.sessionId, "sa_test_session");
      assert.ok(
        warnings.some((warning) =>
          warning.includes("owner resume still failing") && warning.includes(server.surfaceId),
        ),
      );
    });
  });

  await t.test("ownership.relinquish disables auto-retry and clears local ownership state", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const result = await runtime.relinquish({ fingerprint: server.surfaceId });
      assert.deepEqual(result, { relinquished: true });

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await waitFor(() => surface.workPromise === null, 3_000);
      assert.equal(surface.autoRetryEnabled, false);
      assert.equal(surface.connectionState, "unreachable");
      assert.equal(surface.hasPairedInGatewaySession, false);
      assert.equal(surface.sessionId, null);
      assert.equal(server.pairedSocket, null);
    });
  });

  await t.test("repeated busy reconnect failures rotate provider identity and recover automatically", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      const initialProviderId = server.pairAttemptDetails[0]?.providerId;
      assert.equal(typeof initialProviderId, "string");
      server.lockUntilNewProviderIdCode = "busy";
      server.lockUntilNewProviderIdProviderId = initialProviderId ?? null;

      await surface.client.close(1000, "test_busy_provider_rotation");

      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      internalRuntime.wakeSurfaceRetry(surface);
      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      internalRuntime.wakeSurfaceRetry(surface);
      await waitFor(() => server.pairAttemptDetails.length >= 5, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      const reconnectAttempts = server.pairAttemptDetails.slice(1);
      assert.deepEqual(
        reconnectAttempts.slice(0, 3).map((attempt) => attempt.providerId),
        [initialProviderId, initialProviderId, initialProviderId],
      );
      assert.notEqual(reconnectAttempts[3]?.providerId, initialProviderId);
      assert.ok(reconnectAttempts.every((attempt) => attempt.takeover === false));
      assert.ok(
        warnings.some((warning) => warning.includes("rotating provider identity")),
      );
      assert.ok(
        warnings.some((warning) => warning.includes("rotated provider identity")),
      );
    });
  });

  await t.test("repeated invalid_resume reconnect failures rotate provider identity and recover automatically", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      const initialProviderId = server.pairAttemptDetails[0]?.providerId;
      assert.equal(typeof initialProviderId, "string");
      server.lockUntilNewProviderIdCode = "invalid_resume";
      server.lockUntilNewProviderIdProviderId = initialProviderId ?? null;

      await surface.client.close(1000, "test_invalid_resume_provider_rotation");

      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      internalRuntime.wakeSurfaceRetry(surface);
      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      internalRuntime.wakeSurfaceRetry(surface);
      await waitFor(() => server.pairAttemptDetails.length >= 5, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      const reconnectAttempts = server.pairAttemptDetails.slice(1);
      assert.deepEqual(
        reconnectAttempts.slice(0, 3).map((attempt) => attempt.providerId),
        [initialProviderId, initialProviderId, initialProviderId],
      );
      assert.notEqual(reconnectAttempts[3]?.providerId, initialProviderId);
      assert.ok(reconnectAttempts.every((attempt) => attempt.takeover === false));
      assert.ok(
        warnings.some((warning) => warning.includes("rotating provider identity")),
      );
      assert.ok(
        warnings.some((warning) => warning.includes("rotated provider identity")),
      );
    });
  });

  await t.test("connect refusal refreshes discovery and rebinds the surface to the new endpoint", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server, warnings }) => {
      const replacementPort = nextPort++;
      const replacementServer = new FakeSurfAceWsServer(replacementPort);

      try {
        discovery.setEndpoints([discoveryEndpoint(replacementPort)]);

        server.pairedSocket?.close(1000, "test_endpoint_rollover");
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        await server.close();

        await waitFor(() => replacementServer.pairedSocket !== null, 12_000);
        await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(replacementServer.surfaceId);
        assert.ok(surface);
        assert.equal(surface.endpointId, `endpoint-${replacementPort}`);
        assert.ok(warnings.some((warning) => warning.includes("refreshed stale endpoint")));
      } finally {
        await replacementServer.close();
      }
    });
  });

  await t.test("endpoint url changes reset backoff and wake a sleeping worker immediately", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const replacementPort = nextPort++;
      const replacementServer = new FakeSurfAceWsServer(replacementPort);

      try {
        const internalRuntime = runtime as any;
        const originalSurface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(originalSurface);
        assert.ok(originalSurface.client);

        await originalSurface.client.close(1000, "test_endpoint_url_change_wake");
        await server.close();

        await waitFor(() => originalSurface.reconnectAttempt >= 1, 12_000);
        originalSurface.reconnectAttempt = 4;
        originalSurface.unreachableFailures = 3;

        internalRuntime.refreshEndpointTopology(discoveryEndpoint(replacementPort));

        assert.equal(originalSurface.endpointId, `endpoint-${replacementPort}`);
        assert.equal(originalSurface.reconnectAttempt, 0);
        assert.equal(originalSurface.unreachableFailures, 0);

        await waitFor(() => replacementServer.pairedSocket !== null, 3_000);
        await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 3_000);
      } finally {
        await replacementServer.close();
      }
    });
  });

  await t.test("fingerprint identity reuses the existing worker when endpoint ids churn", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const replacementPort = nextPort++;
      const replacementServer = new FakeSurfAceWsServer(replacementPort);

      try {
        const internalRuntime = runtime as any;
        const originalSurface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(originalSurface);

        internalRuntime.refreshEndpointTopology({
          ...discoveryEndpoint(replacementPort, originalSurface.fingerprintPrefix),
          endpointId: `endpoint-${replacementPort}`,
        });

        assert.equal(internalRuntime.surfaces.get(server.surfaceId), originalSurface);
        assert.equal(originalSurface.endpointId, `endpoint-${replacementPort}`);

        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });

        assert.equal(replacementServer.pairedSocket, null);
        assert.equal(server.pairAttemptDetails.length, 1);
      } finally {
        await replacementServer.close();
      }
    });
  });

  await t.test("discovery recreates a stopped surface when the endpoint reappears", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const originalSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(originalSurface);

      originalSurface.stopRequested = true;
      internalRuntime.refreshEndpointTopology(structuredClone(originalSurface.endpoint));

      const recreatedSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(recreatedSurface);
      assert.notEqual(recreatedSurface, originalSurface);
      assert.equal(recreatedSurface.stopRequested, false);
      assert.equal(recreatedSurface.endpointId, originalSurface.endpointId);
    });
  });

  await t.test("pair response replaces stale local panes from prior sessions", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      internalRuntime.applyPairState(surface, {
        id: "rq_repair",
        ok: true,
        op: "pair.request",
        payload: {
          capabilities: {
            contentTypes: ["html", "image", "pdf", "terminal", "markdown"],
            eventTypes: [],
          },
          eventConfig: {
            activeEvents: [],
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
          sessionId: "sa_repaired",
          state: {
            panes: [
              {
                contentType: null,
                currentContentId: null,
                currentRevision: 0,
                paneId: server.initialRemotePaneId,
              },
            ],
          },
          surfaceId: server.surfaceId,
          surfaceName: "Surface A",
          viewport: { height: 768, scale: 2, width: 1024 },
        },
        sentAt: Date.now(),
        type: "response",
        v: 1,
      });

      const screens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1]);
    });
  });

  await t.test("pair.request includes configured providerName", async () => {
    await withRuntimeHarness({
      providerName: "CLU / Surf Ace",
      run: async ({ server }) => {
        assert.equal(server.pairAttemptDetails[0]?.providerName, "CLU / Surf Ace");
      },
    });
  });

  await t.test("providerNameForSurface never falls back to pane session keys", async () => {
    await withRuntimeHarness({
      providerName: "CLU / Surf Ace",
      run: async ({ runtime, server }) => {
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        surface.panes.get(firstPaneId).pendingOwnerSessionKey = "agent:main:clawline:flynn:main";
        surface.panes.get(firstPaneId).ownerSessionKey = "agent:main:clawline:flynn:main";
        assert.equal(internalRuntime.providerNameForSurface(surface), "CLU / Surf Ace");
      },
    });
  });

  await t.test("pair bootstrap preserves the stable first-pane remote id across reconnects", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      const bootstrapPaneId = internalRuntime.ensureInitialPairPane(surface);
      assert.equal(bootstrapPaneId, server.initialRemotePaneId);
      assert.equal(surface.panes.size, 3);
      assert.equal(surface.panes.get(firstPaneId)?.remotePaneId, server.initialRemotePaneId);
    });
  });

  await t.test("reconnect pair requests reuse the stable first-pane remote id", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const beforeReconnect = (await runtime.listScreens())[0]?.panes.map((pane) => pane.paneId);
      assert.equal(beforeReconnect?.length, 1);
      beforeReconnect?.forEach((paneId) => assertOpaquePaneId(paneId));

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      await surface.client.close(1000, "test_reconnect_stable_pane_id");

      await waitFor(() => server.pairRequests.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(server.pairRequests.map((request) => request.initialPaneId), [
        1,
        server.initialRemotePaneId,
      ]);

      const afterReconnect = (await runtime.listScreens())[0]?.panes.map((pane) => pane.paneId);
      assert.deepEqual(afterReconnect, beforeReconnect);
    });
  });

  await t.test("reconnect remap preserves the existing local pane label for a non-pristine sole pane", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      await runtime.push(
        {
          content: "<p>persist me</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:reconnect-remap" },
      );

      const originalPane = surface.panes.get(firstPaneId);
      assert.ok(originalPane);
      assert.equal(originalPane.paneLabel, 1);
      assert.notEqual(originalPane.activeContentId, null);

      server.panes.clear();
      server.panes.set(900, {
        contentId: null,
        contentType: null,
        drawings: [],
        name: null,
        paneLabel: 900,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      });

      await surface.client.close(1000, "test_reconnect_preserve_local_pane_label");

      await waitFor(() => server.pairRequests.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      const afterReconnect = (await runtime.listScreens())[0];
      assertPaneLabelsWithOpaqueIds(afterReconnect?.panes ?? [], [1]);

      const remappedPane = surface.panes.get(firstPaneId);
      assert.ok(remappedPane);
      assert.equal(remappedPane.remotePaneId, 900);

      await runtime.push(
        {
          content: "<p>after reconnect</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:reconnect-remap" },
      );
      assert.equal(server.contentSetRequests.at(-1)?.paneId, 900);
    });
  });

  await t.test("surface-id remap preserves existing pane topology until pair response arrives", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);

      const internalRuntime = runtime as any;
      const preservedSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(preservedSurface);

      const bootstrapPane = structuredClone(preservedSurface.panes.get(firstPaneId));
      assert.ok(bootstrapPane);

      const provisionalSurface = {
        ...preservedSurface,
        client: {
          isOpen: () => true,
          request: async () => ({
            id: "rq_surfaces_list",
            ok: true,
            op: "surfaces.list",
            payload: {
              surfaces: [
                {
                  name: preservedSurface.name,
                  paired: false,
                  surfaceId: server.surfaceId,
                  viewport: preservedSurface.viewport,
                },
              ],
            },
            sentAt: Date.now(),
            type: "response",
            v: 1,
          }),
        },
        connectedAt: null,
        endpoint: {
          ...preservedSurface.endpoint,
          endpointId: "endpoint-reconnect",
          fingerprintPrefix: "",
        },
        endpointId: "endpoint-reconnect",
        fingerprintPrefix: "",
        hasPairedInGatewaySession: false,
        panes: new Map([[bootstrapPane.paneId, bootstrapPane]]),
        recentEventIds: [...preservedSurface.recentEventIds],
        recentEventIdsSet: new Set(preservedSurface.recentEventIdsSet),
        retryDelayResolver: null,
        sessionId: null,
        snapshotBufferedEvents: [...preservedSurface.snapshotBufferedEvents],
        stopRequested: false,
        surfaceId: "sf_disc_reconnect" as any,
        workPromise: null,
      };

      internalRuntime.surfaces.set(provisionalSurface.surfaceId, provisionalSurface);
      await internalRuntime.discoverSurfaceId(provisionalSurface);

      const screen = (await runtime.listScreens()).find((entry) => entry.fingerprint === server.surfaceId);
      assert.ok(screen);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1, 2, 3]);
      assert.equal(preservedSurface.stopRequested, true);
      assert.equal(preservedSurface.autoRetryEnabled, false);
      await waitFor(() => preservedSurface.client === null, 5_000);
    });
  });

  await t.test("pair.response canonicalization collapses duplicate provisional surfaces onto the canonical surface id", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);

      const internalRuntime = runtime as any;
      const canonicalSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(canonicalSurface);

      const bootstrapPane = structuredClone(canonicalSurface.panes.get(firstPaneId));
      assert.ok(bootstrapPane);

      const provisionalSurface = {
        ...canonicalSurface,
        client: {
          close: async () => {},
          isOpen: () => true,
          request: async () => {
            throw new Error("not used in canonicalization test");
          },
        },
        connectedAt: null,
        endpoint: {
          ...canonicalSurface.endpoint,
          endpointId: "endpoint-duplicate-hostname",
          fingerprintPrefix: "",
        },
        endpointId: "endpoint-duplicate-hostname",
        fingerprintPrefix: "",
        hasPairedInGatewaySession: false,
        panes: new Map([[bootstrapPane.paneId, bootstrapPane]]),
        recentEventIds: [...canonicalSurface.recentEventIds],
        recentEventIdsSet: new Set(canonicalSurface.recentEventIdsSet),
        retryDelayResolver: null,
        sessionId: null,
        snapshotBufferedEvents: [...canonicalSurface.snapshotBufferedEvents],
        stopRequested: false,
        surfaceId: "sf_disc_duplicate_hostname" as any,
        workPromise: null,
      };

      internalRuntime.surfaces.set(provisionalSurface.surfaceId, provisionalSurface);
      internalRuntime.adoptCanonicalSurfaceId(provisionalSurface, server.surfaceId, "pair.response");

      assert.equal(internalRuntime.surfaces.has("sf_disc_duplicate_hostname"), false);
      assert.equal(internalRuntime.surfaces.get(server.surfaceId), provisionalSurface);
      const screens = await runtime.listScreens();
      assert.equal(screens.filter((entry) => entry.fingerprint === server.surfaceId).length, 1);
      const screen = screens.find((entry) => entry.fingerprint === server.surfaceId);
      assert.ok(screen);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1, 2, 3]);
      assert.equal(canonicalSurface.stopRequested, true);
      assert.equal(canonicalSurface.autoRetryEnabled, false);
      await waitFor(() => canonicalSurface.client === null, 5_000);
    });
  });

  await t.test("stable surfaceId plus remotePaneId preserves paneLabel across reconnect bootstrap", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, {
      initialRemotePaneId: 41,
      surfaceId: "sf_surface-a",
    });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-pane-label-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtimeA = createSurfAceRuntime({ discovery, stateDir });
    const runtimeB = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtimeA.start();
      await waitFor(() => server.pairedSocket !== null);

      const beforeRestart = (await runtimeA.listScreens())[0];
      const beforePaneIds = assertPaneLabelsWithOpaqueIds(beforeRestart?.panes ?? [], [1]);

      await runtimeA.stop();
      await waitFor(() => server.activeSocketCount === 0);

      await runtimeB.start();
      await waitFor(() => server.pairRequests.length >= 2);
      await waitFor(() => server.pairedSocket !== null);

      const afterRestart = (await runtimeB.listScreens())[0];
      assert.ok(afterRestart);
      assert.equal(afterRestart.panes.length, 1);
      assertOpaquePaneId(afterRestart.panes[0]?.paneId);
      assert.notEqual(afterRestart.panes[0]?.paneId, beforePaneIds[0]);
      assert.equal(afterRestart.panes[0]?.paneLabel, 1);
    } finally {
      await runtimeB.stop();
      await runtimeA.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("single invalid_resume clears the stale session and retries as a fresh owner pair", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      assert.equal(surface.sessionId, "sa_test_session");

      server.resumePairMismatchMessage = "Resume session did not match active ownership lock";
      server.rejectNextResumePairWithSessionMismatch = true;
      await surface.client.close(1000, "test_resume_restart");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(server.pairAttemptDetails[1]?.resumeSessionId, "sa_test_session");
      assert.equal(server.pairAttemptDetails[1]?.takeover, false);
      assert.equal(server.pairAttemptDetails[2]?.resumeSessionId, null);
      assert.equal(server.pairAttemptDetails[2]?.takeover, false);
      assert.equal(surface.sessionId, "sa_test_session");
    });
  });

  await t.test("busy after a cold-start reconnect backs off without takeover", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;

      // Return busy once, then allow the next non-takeover retry to succeed.
      server.busyWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_cold_start_busy_backoff");

      // Wait for reconnect: first attempt gets busy, the next retry stays non-takeover and succeeds.
      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.ok(
        server.pairAttemptDetails.slice(1, 3).every((attempt) => attempt.takeover === false),
        "cold-start busy recovery must not escalate to takeover",
      );
      assert.ok(
        warnings.some((warning) => warning.includes("backing off") && warning.includes("takeover requires explicit user action")),
      );
    });
  });

  await t.test("busy after a live-session drop backs off without takeover", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      assert.equal(surface.hasPairedInGatewaySession, true);

      // Return busy once, then succeed — validates no takeover on retry
      server.busyWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_live_session_busy_backoff");

      // Wait for reconnect: first attempt gets busy, second succeeds
      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.ok(
        server.pairAttemptDetails.slice(1).every((attempt) => attempt.takeover === false),
        "no reconnect attempt should use takeover",
      );
      assert.ok(
        warnings.some((warning) => warning.includes("backing off") && warning.includes("takeover requires explicit user action")),
      );
    });
  });

  await t.test("invalid_resume after a cold-start reconnect retries fresh without takeover", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;

      server.invalidResumeWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_cold_start_invalid_resume_fresh");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 3).map((attempt) => attempt.resumeSessionId),
        [null, null],
      );
      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 3).map((attempt) => attempt.takeover),
        [false, false],
      );
      assert.ok(
        warnings.some((warning) =>
          warning.includes("retrying fresh (no takeover)")),
      );
      assert.equal(surface.sessionId, "sa_test_session");
    });
  });

  await t.test("cold-start invalid_resume ignores legacy endpoint mapping state without takeover", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      internalRuntime.persistentState.endpointSurfaces = {
        [surface.endpointId]: "sf_stale_surface",
      };

      server.invalidResumeWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_stale_endpoint_surface_mapping");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 20_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1).map((attempt) => attempt.takeover),
        [false, false],
      );
      assert.ok(
        warnings.some((warning) =>
          warning.includes("retrying fresh (no takeover)")),
      );
      assert.equal(surface.sessionId, "sa_test_session");
    });
  });

});
