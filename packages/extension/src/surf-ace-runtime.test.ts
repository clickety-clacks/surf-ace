import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocketServer } from "ws";
import type WebSocket from "ws";

import type { SurfAceDiscoveryEndpoint, SurfAceDiscoveryService } from "./surf-ace-discovery.js";
import { createSurfAceRuntime, resolveDefaultSurfAceStateDir } from "./surf-ace-runtime.js";

type TestPane = {
  contentId: string | null;
  contentType: string | null;
  drawings: string[];
  externalNative?: boolean;
  frame: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  name: string | null;
  paneLabel: number;
  paneLineageId: string;
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
    content: unknown;
    contentId: string;
    contentType: string;
    displayProvenance?: unknown;
    displayTitle?: string | null;
    historyOwnerToken: string;
    paneId: number;
    revision: number;
  }> = [];
  readonly targetApplyRequests: Array<{
    materialization: unknown;
    ownershipEpoch: number;
    ownershipSessionId: string;
    paneLineageId: string;
    displayProvenance?: unknown;
    displayTitle?: string | null;
    restoreReason: string;
    targetHeader: unknown;
    targetId: string;
    targetKind: string;
    targetPayload: unknown;
  }> = [];
  targetApplyErrorCode: string | null = null;
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
  panesListRequests = 0;
  readonly panes: Map<number, TestPane>;
  readonly splitRequests: Array<{
    count: number;
    direction: string;
    newPaneIds: number[];
    newPaneLabels: number[];
    paneId: number;
  }> = [];
  nextTopologyApplyError: { code: string; message: string } | null = null;
  nextTopologyApplyResponsePaneLabels: number[] | null = null;
  nextContentApplyError: { code: string; details?: Record<string, unknown>; message: string } | null = null;
  nextContentApplyRenderStatus: string | null = null;
  snapshotDelayMs = 0;
  snapshotImage = "aGVsbG8=";
  snapshotRequests: Array<{ includeImage: boolean; includeVisibleText: boolean; paneId: number }> = [];
  snapshotScrollOffset = { x: 0, y: 0 };
  targetApplyResultErrorCode: string | null = null;
  targetCapabilities = [
    "target.html.v1",
    "target.markdown.v1",
    "target.image.v1",
    "target.terminal_app.v1",
    "target.native_app.v1",
    "target.compositor_app.v1",
  ];
  dropNextSplitRequest = false;
  forcedPairErrors: Array<{ code: string; message: string }> = [];
  busyWithoutTakeoverMessage = "Surface is already paired";
  invalidResumeWithoutTakeoverResponsesRemaining = 0;
  lockedProviderId: string | null = null;
  lockedSessionId: string | null = null;
  lockUntilNewProviderIdCode: "busy" | "invalid_resume" | null = null;
  lockUntilNewProviderIdProviderId: string | null = null;
  maxConcurrentSocketCount = 0;
  rejectNextResumePairWithSessionMismatch = false;
  resumePairMismatchResponsesRemaining = 0;
  resumePairMismatchMessage = "Resume session did not match active ownership lock";
  includePairPaneLineageIds = true;
  forceEmptyPairResponsePanes = false;
  surfacesListErrorCode: string | null = null;
  surfacesListRequests = 0;

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
          frame: {
            height: 768,
            width: 1024,
            x: 0,
            y: 0,
          },
          name: null,
          paneLabel: this.initialRemotePaneId,
          paneLineageId: `pl_${this.surfaceId}_${this.initialRemotePaneId}`,
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
    for (const socket of this.sockets) {
      socket.close(1000, "test_server_close");
      socket.terminate();
    }
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
            frame: {
              height: viewport.height,
              width: viewport.width,
              x: 0,
              y: 0,
            },
            name: null,
            paneLabel: initialRemotePaneId,
            paneLineageId: `pl_${options.surfaceId}_${initialRemotePaneId}`,
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

  removeSurfaceWithoutEvent(surfaceId: string): void {
    this.pairedSocketsBySurfaceId.get(surfaceId)?.close(1000, "surface_removed");
    this.surfaces.delete(surfaceId);
  }

  omitSurfaceFromList(surfaceId: string): void {
    this.surfaces.delete(surfaceId);
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
        this.surfacesListRequests += 1;
        if (this.surfacesListErrorCode) {
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "surfaces.list",
                this.surfacesListErrorCode,
                "surfaces.list unavailable",
              ),
            ),
          );
          return;
        }
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
                this.busyWithoutTakeoverMessage,
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
        const resumeSessionId =
          typeof message.payload?.resume === "object" &&
          message.payload.resume !== null &&
          typeof (message.payload.resume as { sessionId?: unknown }).sessionId === "string"
            ? String((message.payload.resume as { sessionId: string }).sessionId)
            : null;
        let pairResponseResumed = resumeSessionId !== null;
        let pairResponseSessionId = resumeSessionId ?? "sa_test_session";
        if (this.lockedProviderId && this.lockedSessionId) {
          const attemptedProviderId = this.pairAttemptDetails.at(-1)?.providerId;
          const attemptedResumeSessionId = this.pairAttemptDetails.at(-1)?.resumeSessionId;
          if (attemptedProviderId !== this.lockedProviderId) {
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
          if (message.payload?.takeover) {
            pairResponseResumed = false;
            pairResponseSessionId = "sa_test_session";
          } else if (attemptedResumeSessionId !== this.lockedSessionId) {
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
          } else {
            pairResponseResumed = true;
            pairResponseSessionId = this.lockedSessionId;
          }
        }
        const requestedSurface = this.requireSurface(String(message.payload?.surfaceId ?? this.surfaceId));
        const pairResponsePanes = this.forceEmptyPairResponsePanes
          ? []
          : [...requestedSurface.panes.entries()].map(([paneId, pane]) => ({
              contentType: pane.contentType,
              currentContentId: pane.contentId,
              currentRevision: pane.revision,
              paneId,
              paneLabel: pane.paneLabel,
              ...(this.includePairPaneLineageIds ? { paneLineageId: pane.paneLineageId } : {}),
            }));
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
                targetCapabilities: [...this.targetCapabilities],
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
              resumed: pairResponseResumed,
              sessionId: pairResponseSessionId,
              state: {
                panes: pairResponsePanes,
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
        if (this.dropNextSplitRequest) {
          this.dropNextSplitRequest = false;
          socket.close(1011, "drop_next_topology_apply");
          return;
        }
        this.topologyApplyRequests.push({
          layout: structuredClone(message.payload?.layout ?? null),
          paneIds: panes.map((pane) => pane.paneId),
          paneLabels: panes.map((pane) => pane.paneLabel),
          topologyRevision: Number(message.payload?.topologyRevision ?? 0),
          windowLabel: String(message.payload?.windowLabel ?? ""),
        });
        if (this.nextTopologyApplyError) {
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "topology.apply",
                this.nextTopologyApplyError.code,
                this.nextTopologyApplyError.message,
              ),
            ),
          );
          this.nextTopologyApplyError = null;
          return;
        }
        const previousPanes = new Map(targetSurface.panes);
        targetSurface.panes.clear();
        for (const paneState of panes) {
          const previousPane = previousPanes.get(paneState.paneId);
          targetSurface.panes.set(paneState.paneId, {
            contentId: previousPane?.contentId ?? null,
            contentType: previousPane?.contentType ?? null,
            drawings: previousPane?.drawings ? [...previousPane.drawings] : [],
            frame: previousPane?.frame ?? {
              height: targetSurface.viewport.height,
              width: targetSurface.viewport.width,
              x: 0,
              y: 0,
            },
            name: paneState.name,
            paneLabel: paneState.paneLabel,
            paneLineageId: previousPane?.paneLineageId ?? `pl_${targetSurface.surfaceId}_${paneState.paneId}`,
            revision: previousPane?.revision ?? 0,
            viewport: previousPane?.viewport ?? { ...targetSurface.viewport },
          });
        }
        this.applyTopologyFrames(targetSurface, message.payload?.layout);
        socket.send(
          JSON.stringify(
            this.response(message.id, "topology.apply", {
              panes: panes.map((pane, index) => ({
                name: pane.name,
                paneId: pane.paneId,
                paneLabel: this.nextTopologyApplyResponsePaneLabels?.[index] ?? pane.paneLabel,
                paneLineageId: targetSurface.panes.get(pane.paneId)?.paneLineageId ?? `pl_${targetSurface.surfaceId}_${pane.paneId}`,
              })),
              topologyRevision: Number(message.payload?.topologyRevision ?? 0),
            }),
          ),
        );
        this.nextTopologyApplyResponsePaneLabels = null;
        return;
      }
      case "content.apply": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = targetSurface.panes.get(paneId);
        assert.ok(pane);
        if (this.nextContentApplyError) {
          const error = this.nextContentApplyError;
          this.nextContentApplyError = null;
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "content.apply",
                error.code,
                error.message,
                error.details,
              ),
            ),
          );
          return;
        }
        if (message.payload && "clear" in message.payload) {
          pane.contentId = null;
          pane.contentType = null;
          pane.drawings = [];
          pane.externalNative = false;
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
        const nextContentId = String(message.payload?.contentId);
        const previousContentId = pane.contentId;
        pane.contentId = nextContentId;
        pane.contentType = String(message.payload?.contentType);
        pane.revision = Number(message.payload?.revision ?? pane.revision + 1);
        if (previousContentId !== pane.contentId) {
          pane.drawings = [];
        }
        this.contentSetRequests.push({
          content: structuredClone(message.payload?.content),
          contentId: pane.contentId,
          contentType: pane.contentType,
          displayProvenance: structuredClone(message.payload?.display?.provenance ?? null),
          displayTitle: typeof message.payload?.display?.title === "string" ? message.payload.display.title : null,
          historyOwnerToken: String(message.payload?.historyOwnerToken ?? ""),
          paneId,
          revision: pane.revision,
        });
        const renderStatus = this.nextContentApplyRenderStatus;
        this.nextContentApplyRenderStatus = null;
        const responsePayload: Record<string, unknown> = {
          contentId: pane.contentId,
          contentType: pane.contentType,
          currentContentId: pane.contentId,
          currentRevision: pane.revision,
          paneId,
          topologyRevision: message.payload?.topologyRevision,
        };
        if (renderStatus) {
          responsePayload.render = {
            bridgeAttached: renderStatus !== "pending_renderer",
            contentId: pane.contentId,
            contentType: pane.contentType,
            revision: pane.revision,
            status: renderStatus,
          };
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "content.apply", responsePayload),
          ),
        );
        return;
      }
      case "target.apply": {
        this.targetApplyRequests.push({
          materialization: structuredClone(message.payload?.materialization),
          ownershipEpoch: Number(message.payload?.ownershipEpoch ?? 0),
          ownershipSessionId: String(message.payload?.ownershipSessionId ?? ""),
          paneLineageId: String(message.payload?.paneLineageId ?? ""),
          ...(message.payload?.display
            ? {
                displayProvenance: structuredClone(message.payload.display.provenance ?? null),
                displayTitle: typeof message.payload.display.title === "string" ? message.payload.display.title : null,
              }
            : {}),
          restoreReason: String(message.payload?.restoreReason ?? ""),
          targetHeader: structuredClone(message.payload?.targetHeader),
          targetId: String(message.payload?.targetId ?? ""),
          targetKind: String(message.payload?.targetKind ?? ""),
          targetPayload: structuredClone(message.payload?.targetPayload),
        });
        if (this.targetApplyErrorCode) {
          socket.send(
            JSON.stringify(
              this.errorResponse(message.id, "target.apply", this.targetApplyErrorCode, "target apply failed"),
            ),
          );
          return;
        }
        if (this.targetApplyResultErrorCode) {
          socket.send(
            JSON.stringify(
              this.response(message.id, "target.apply.result", {
                appliedAt: new Date().toISOString(),
                errorCode: this.targetApplyResultErrorCode,
                message: "target.apply ownershipEpoch does not match the active session",
                paneLineageId: String(message.payload?.paneLineageId ?? ""),
                requestId: String(message.payload?.requestId ?? message.id),
                status: "rejected",
                targetEpoch: Number(message.payload?.targetEpoch ?? 0),
                targetId: String(message.payload?.targetId ?? ""),
              }),
            ),
          );
          return;
        }
        if (message.payload?.materialization?.op === "native_pane.host") {
          const targetSurface = this.requirePairedSurface(socket);
          for (const paneMaterialization of message.payload.materialization.panes ?? []) {
            const pane = targetSurface.panes.get(Number(paneMaterialization.id));
            if (pane) {
              pane.contentId = null;
              pane.contentType = null;
              pane.externalNative = true;
            }
          }
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "target.apply.result", {
              appliedAt: new Date().toISOString(),
              materializedState: { paneLineageId: String(message.payload?.paneLineageId ?? "") },
              paneLineageId: String(message.payload?.paneLineageId ?? ""),
              requestId: String(message.payload?.requestId ?? message.id),
              status: "applied",
              targetEpoch: Number(message.payload?.targetEpoch ?? 0),
              targetId: String(message.payload?.targetId ?? ""),
            }),
          ),
        );
        return;
      }
      case "panes.list": {
        this.panesListRequests += 1;
        const targetSurface = this.requirePairedSurface(socket);
        socket.send(
          JSON.stringify(
            this.response(message.id, "panes.list", {
              panes: [...targetSurface.panes.entries()].map(([paneId, pane]) => ({
                activeContentId: pane.contentId,
                contentType: pane.contentType,
                externalNative: pane.externalNative ?? false,
                geometry: this.paneGeometry(targetSurface, paneId, pane),
                name: pane.name,
                paneId,
                paneLabel: pane.paneLabel,
                paneLineageId: pane.paneLineageId,
                viewport: {
                  height: pane.frame.height,
                  scale: pane.viewport.scale,
                  width: pane.frame.width,
                },
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
        pane.externalNative = false;
        pane.revision = Number(message.payload?.revision ?? pane.revision + 1);
        pane.drawings = [];
        this.contentSetRequests.push({
          content: structuredClone(message.payload?.content),
          contentId: pane.contentId,
          contentType: pane.contentType,
          displayProvenance: structuredClone(message.payload?.display?.provenance ?? null),
          displayTitle: typeof message.payload?.display?.title === "string" ? message.payload.display.title : null,
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
        pane.externalNative = false;
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
        const splitDirection = String(message.payload?.direction ?? "");
        const splitCount = newPaneIds.length + 1;
        const sourceFrame = { ...sourcePane.frame };
        const sourceViewport = { ...sourcePane.viewport };
        if (splitDirection === "horizontal") {
          const height = sourceFrame.height / splitCount;
          sourcePane.frame = { ...sourceFrame, height };
          sourcePane.viewport = { ...sourceViewport, height };
        } else {
          const width = sourceFrame.width / splitCount;
          sourcePane.frame = { ...sourceFrame, width };
          sourcePane.viewport = { ...sourceViewport, width };
        }
        for (const [index, newPaneId] of newPaneIds.entries()) {
          const segmentIndex = index + 1;
          const frame = splitDirection === "horizontal"
            ? {
                height: sourcePane.frame.height,
                width: sourceFrame.width,
                x: sourceFrame.x,
                y: sourceFrame.y + sourcePane.frame.height * segmentIndex,
              }
            : {
                height: sourceFrame.height,
                width: sourcePane.frame.width,
                x: sourceFrame.x + sourcePane.frame.width * segmentIndex,
                y: sourceFrame.y,
              };
          targetSurface.panes.set(newPaneId, {
            contentId: null,
            contentType: null,
            drawings: [],
            frame,
            name: null,
            paneLabel: newPaneLabels[index] ?? newPaneId,
            revision: 0,
            viewport: {
              height: frame.height,
              scale: sourcePane.viewport.scale,
              width: frame.width,
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

  private paneGeometry(surface: TestSurfaceState, paneId: number, pane: TestPane) {
    const topologyEpoch = this.topologyApplyRequests.at(-1)?.topologyRevision ?? 0;
    const contentViewport = { ...pane.frame };
    return {
      contentViewport,
      coordinateSpace: "surface_logical",
      geometryRevision: topologyEpoch + 2,
      paneFrame: { ...pane.frame },
      paneId,
      paneInstanceId: `pl_${surface.surfaceId}_${paneId}`,
      protocolViewport: {
        coordinateSpace: "protocol_viewport",
        rect: { ...pane.frame },
        viewport: {
          height: pane.frame.height,
          scale: pane.viewport.scale,
          width: pane.frame.width,
        },
      },
      safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 },
      scale: pane.viewport.scale,
      splitSpacingInsets: { bottom: 0, left: 0, right: 0, top: 0 },
      surfaceBounds: {
        height: surface.viewport.height,
        width: surface.viewport.width,
        x: 0,
        y: 0,
      },
      surfaceEpoch: `${surface.surfaceId}:1`,
      topologyEpoch,
    };
  }

  private applyTopologyFrames(surface: TestSurfaceState, layout: unknown): void {
    const assign = (node: unknown, rect: { height: number; width: number; x: number; y: number }): void => {
      if (!node || typeof node !== "object") {
        return;
      }
      const record = node as Record<string, unknown>;
      if (record.type === "pane") {
        const paneId = Number(record.paneId ?? 0);
        const pane = surface.panes.get(paneId);
        if (!pane) {
          return;
        }
        pane.frame = { ...rect };
        pane.viewport = {
          height: rect.height,
          scale: surface.viewport.scale,
          width: rect.width,
        };
        return;
      }
      if (record.type !== "split" || !Array.isArray(record.children) || record.children.length === 0) {
        return;
      }
      const children = record.children;
      if (record.direction === "horizontal") {
        const height = rect.height / children.length;
        children.forEach((child, index) => {
          assign(child, { height, width: rect.width, x: rect.x, y: rect.y + height * index });
        });
        return;
      }
      const width = rect.width / children.length;
      children.forEach((child, index) => {
        assign(child, { height: rect.height, width, x: rect.x + width * index, y: rect.y });
      });
    };

    assign(layout, {
      height: surface.viewport.height,
      width: surface.viewport.width,
      x: 0,
      y: 0,
    });
  }

  private errorResponse(
    id: string,
    op: string,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    return {
      error: {
        code,
        ...(details ? { details } : {}),
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
          infos: string[];
          warnings: string[];
          runtime: ReturnType<typeof createSurfAceRuntime>;
          server: FakeSurfAceWsServer;
        },
      ) => Promise<void>)
    | {
        configureServer?: (server: FakeSurfAceWsServer) => void;
        now?: () => number;
        providerName?: string;
        waitForPair?: boolean;
        run: (ctx: {
          alertBodies: Array<Record<string, unknown>>;
          annotationTurns: import("./surf-ace-runtime.js").SurfAceAnnotationIntentTurn[];
          discovery: StaticDiscoveryService;
          infos: string[];
          warnings: string[];
          runtime: ReturnType<typeof createSurfAceRuntime>;
          server: FakeSurfAceWsServer;
        }) => Promise<void>;
      },
): Promise<void> {
  const options =
    typeof optionsOrRun === "function"
      ? { configureServer: undefined, run: optionsOrRun, now: undefined, providerName: undefined, waitForPair: true }
      : optionsOrRun;
  const port = nextPort++;
  const server = new FakeSurfAceWsServer(port);
  options.configureServer?.(server);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-"));
  const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
  const infos: string[] = [];
  const warnings: string[] = [];
  const annotationTurns: import("./surf-ace-runtime.js").SurfAceAnnotationIntentTurn[] = [];
  const runtime = createSurfAceRuntime({
    deliverSettledAnnotationTurn: async (turn) => {
      annotationTurns.push(structuredClone(turn));
    },
    discovery,
    logger: {
      info: (message: string) => {
        infos.push(message);
      },
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
    if (options.waitForPair !== false) {
      await waitFor(() => server.pairedSocket !== null);
    }
    await options.run({ alertBodies, annotationTurns, discovery, infos, runtime, server, warnings });
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

function targetRegistrationOwnership(
  runtime: ReturnType<typeof createSurfAceRuntime>,
  surfaceId: string,
  paneId: string,
): { launchedAt: string; ownershipEpoch: number; ownershipSessionId: string; paneLineageId: string } {
  const surface = (runtime as any).surfaces.get(surfaceId);
  assert.ok(surface);
  const pane = surface.panes.get(paneId);
  assert.ok(pane);
  return {
    launchedAt: new Date().toISOString(),
    ownershipEpoch: surface.ownershipEpoch,
    ownershipSessionId: surface.sessionId,
    paneLineageId: pane.paneLineageId,
  };
}

test("surf ace runtime defaults to the OpenClaw extension state root", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  try {
    process.env.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), "openclaw-state-root");
    assert.equal(
      resolveDefaultSurfAceStateDir(),
      path.join(process.env.OPENCLAW_STATE_DIR, "extensions", "surf-ace"),
    );

    const injectedRoot = path.join(os.tmpdir(), "openclaw-injected-state-root");
    const runtime = createSurfAceRuntime({ openClawStateDir: injectedRoot });
    assert.equal((runtime as any).stateDir, path.join(injectedRoot, "extensions", "surf-ace"));
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  }
});

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

  await t.test("passive processes forward pane mutations to the active runtime owner", async () => {
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
      await runtimeB.start();
      await waitFor(async () => (await runtimeB.listScreens()).length === 1);

      const screen = (await runtimeB.listScreens())[0];
      const pane = screen?.panes[0];
      assert.ok(screen);
      assert.ok(pane);

      const pushed = await runtimeB.push({
        content: "# passive owner bridge",
        contentType: "markdown",
        fingerprint: screen.fingerprint,
        paneId: pane.paneId,
      });
      const read = await runtimeB.read({
        fingerprint: screen.fingerprint,
        paneId: pane.paneId,
      });

      assert.equal(pushed.fingerprint, server.surfaceId);
      assert.equal(pushed.paneId, pane.paneId);
      assert.equal(read.fingerprint, server.surfaceId);
      assert.equal(read.paneId, pane.paneId);
      assert.equal(server.contentSetRequests.length, 1);
      assert.equal(server.contentSetRequests[0]?.paneId, server.initialRemotePaneId);
      assert.equal(server.pairRequests.length, 1);
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
          "topology",
          "topologyRevision",
          "viewport",
          "windowLabel",
        ].sort(),
      );
      assert.equal(screen.fingerprint, server.surfaceId);
      assert.equal(screen.windowLabel, "a");
      assert.deepEqual(screen.topology, { paneId: screen.panes[0]?.paneId, type: "pane" });
      assert.equal(screen.topologyRevision, 0);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1]);
      assert.equal(server.initialRemotePaneId, 41);
      assert.deepEqual(
        Object.keys(screen.panes[0] ?? {}).sort(),
        ["activeContent", "historySummary", "name", "paneId", "paneLabel", "target", "viewport"].sort(),
      );
      assert.deepEqual(screen.panes[0]?.viewport, { height: 768, scale: 2, width: 1024 });
    });
  });

  await t.test("listScreens does not advertise connected for a stale closed transport", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await surface.client?.close(1000, "test_stale_closed_transport");
      surface.connectionState = "connected";
      surface.client = {
        close: async () => {},
        isOpen: () => false,
        request: async () => {
          throw new Error("stale transport should not receive requests");
        },
      };

      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      assert.equal(screen.connectionState, "connecting");
      assert.equal(screen._debug?.wsOpen, false);
    });
  });

  await t.test("endpoint identity changes discard stale transport lineage before reconnect", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-endpoint-churn-"));
    const initialEndpoint = discoveryEndpoint(port);
    const discovery = new StaticDiscoveryService([initialEndpoint]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => server.pairedSocket !== null);
      assert.equal(server.pairAttemptDetails.length, 1);

      discovery.setEndpoints([
        {
          ...initialEndpoint,
          endpointId: `${initialEndpoint.endpointId}-after-churn`,
          lastSeenAt: Date.now(),
        },
      ]);
      await discovery.refreshNow();

      await waitFor(() => server.pairAttemptDetails.length >= 2);
      const reconnectAttempt = server.pairAttemptDetails.at(-1);
      assert.ok(reconnectAttempt);
      assert.equal(reconnectAttempt.resumeSessionId, "sa_test_session");
      assert.equal(reconnectAttempt.takeover, false);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("previously unseen remote panes allocate local pane labels instead of using remotePaneId", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      server.panes.set(77, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
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
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 2]);
    });
  });

  await t.test("remote pane ids do not advance visible pane label allocation before later splits", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      server.panes.set(77, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
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
      await waitFor(async () => (await runtime.listScreens())[0]?.panes.length === 2, 12_000);
      const sourcePaneId = await livePaneId(runtime, server.surfaceId, 1);

      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: sourcePaneId,
      });

      const topologyApply = server.topologyApplyRequests.at(-1);
      assert.deepEqual(
        topologyApply?.paneIds
          .map((paneId, index) => ({ paneId, paneLabel: topologyApply.paneLabels[index] }))
          .sort((left, right) => left.paneLabel - right.paneLabel),
        [
          { paneId: server.initialRemotePaneId, paneLabel: 1 },
          { paneId: 77, paneLabel: 2 },
          { paneId: 78, paneLabel: 3 },
        ],
      );
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);
    });
  });

  await t.test("multiple surfaces get unique window labels and per-surface first pane labels", async () => {
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
          { panes: [1], windowLabel: "b" },
        ],
      );
      assert.equal(new Set(firstPaneIds).size, firstPaneIds.length);
      assert.equal(serverA.pairRequests[0]?.windowLabel, "a");
      assert.equal(serverB.pairRequests[0]?.windowLabel, "b");
      const initialRemotePaneIds = [
        serverA.pairRequests[0]?.initialPaneId,
        serverB.pairRequests[0]?.initialPaneId,
      ].filter((paneId): paneId is number => typeof paneId === "number");
      assert.equal(new Set(initialRemotePaneIds).size, 2);
      assert.ok(initialRemotePaneIds.every((paneId) => paneId > 0));
      assert.deepEqual(
        [serverA.pairRequests[0]?.initialPaneLabel, serverB.pairRequests[0]?.initialPaneLabel].sort(),
        [1, 1],
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
          { fingerprint: "sf_surface-b", panes: [1], windowLabel: "b" },
          { fingerprint: "sf_surface-c", panes: [1], windowLabel: "c" },
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
      const initialRemotePaneIds = [...requestsBySurface.values()]
        .map((request) => request?.initialPaneId)
        .filter((paneId): paneId is number => typeof paneId === "number");
      assert.equal(new Set(initialRemotePaneIds).size, 3);
      assert.ok(initialRemotePaneIds.every((paneId) => paneId > 0));
      assert.deepEqual(
        [...requestsBySurface.values()].map((request) => request?.initialPaneLabel).sort(),
        [1, 1, 1],
      );
      const internalRuntime = runtime as any;
      assert.deepEqual(
        [...internalRuntime.surfaces.keys()].sort(),
        ["sf_surface-a", "sf_surface-b", "sf_surface-c"],
      );
      assert.equal(internalRuntime.endpointProbes.size, 1);
      const endpointProbe = internalRuntime.endpointProbes.get(`endpoint-${port}`);
      assert.ok(endpointProbe);
      assert.equal("surfaceId" in endpointProbe, false);
      assert.equal("panes" in endpointProbe, false);
      assert.equal(server.pairedSocketFor("sf_surface-a") === server.pairedSocketFor("sf_surface-b"), false);
      assert.equal(server.pairedSocketFor("sf_surface-b") === server.pairedSocketFor("sf_surface-c"), false);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("endpoint probe retries without visible leakage when surfaces.list is unavailable", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.surfacesListErrorCode = "unsupported";
      },
      waitForPair: false,
      run: async ({ runtime, server }) => {
        const internalRuntime = runtime as any;
        await waitFor(() => server.surfacesListRequests >= 2, 12_000);
        assert.deepEqual(await runtime.listScreens(), []);
        assert.deepEqual([...internalRuntime.surfaces.keys()], []);
        assert.equal(internalRuntime.endpointProbes.size, 1);
        assert.equal([...internalRuntime.surfaces.keys()].some((surfaceId) => surfaceId.startsWith("sf_disc_")), false);
        assert.deepEqual(server.pairRequestSurfaceIds, []);
      },
    });
  });

  await t.test("polluted duplicate pane labels are allowed across live surfaces before exposure", async () => {
    const portA = nextPort++;
    const portB = nextPort++;
    const serverA = new FakeSurfAceWsServer(portA, {
      initialRemotePaneId: 6242,
      surfaceId: "sf_surface-a",
    });
    const serverB = new FakeSurfAceWsServer(portB, {
      initialRemotePaneId: 6243,
      surfaceId: "sf_surface-b",
    });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-duplicate-pane-labels-"));
    const discovery = new StaticDiscoveryService([
      discoveryEndpoint(portA, "aaaabbbb"),
      discoveryEndpoint(portB, "ccccdddd"),
    ]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 6244,
            nextRemotePaneId: 6244,
            nextWindowLabelIndex: 2,
            paneLabelsByPaneId: {
              [`${serverA.surfaceId}::6242`]: 1,
              [`${serverB.surfaceId}::6243`]: 2,
            },
            providerId: "pv_test_provider",
            version: 1,
            windowLabels: {
              [serverA.surfaceId]: "fx",
              [serverB.surfaceId]: "fw",
            },
          },
          null,
          2,
        ),
      );

      await runtime.start();
      await waitFor(() => serverA.pairedSocket !== null && serverB.pairedSocket !== null);

      const screens = await runtime.listScreens();
      assert.deepEqual(
        screens.map((screen) => ({
          panes: screen.panes.map((pane) => pane.paneLabel),
          windowLabel: screen.windowLabel,
        })),
        [
          { panes: [1], windowLabel: "fw" },
          { panes: [1], windowLabel: "fx" },
        ],
      );
      assert.deepEqual(
        [serverA.pairRequests[0]?.initialPaneLabel, serverB.pairRequests[0]?.initialPaneLabel].sort(),
        [1, 1],
      );
      const repairedState = JSON.parse(await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"));
      assert.deepEqual(
        Object.values(repairedState.paneLabelsByPaneId).sort(),
        [1, 1],
      );
      assert.equal(repairedState.nextPaneLabel, 2);
    } finally {
      await runtime.stop();
      await serverB.close();
      await serverA.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("client topology responses cannot overwrite provider pane labels with duplicates", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      server.nextTopologyApplyResponsePaneLabels = [77, 77, 77];

      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: await livePaneId(runtime, server.surfaceId, 1),
      });

      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);
      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assertPaneLabelsWithOpaqueIds(screen?.panes ?? [], [1, 2, 3]);
      assert.deepEqual(server.topologyApplyRequests.at(-1)?.paneLabels, [1, 2, 3]);
    });
  });

  await t.test("client topology rejection is logged with pane label context", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      server.nextTopologyApplyError = {
        code: "invalid_payload",
        message: "duplicate or invalid paneLabel in surface payload",
      };

      await assert.rejects(
        runtime.split({
          count: 2,
          direction: "horizontal",
          fingerprint: server.surfaceId,
          paneId: await livePaneId(runtime, server.surfaceId, 1),
        }),
        /duplicate or invalid paneLabel in surface payload/,
      );

      assert.ok(
        warnings.some((warning) =>
          warning.includes("event=topology_apply_error") &&
          warning.includes(`surface_id=${server.surfaceId}`) &&
          warning.includes("window_label=a") &&
          warning.includes("session_id=sa_test_session") &&
          warning.includes("pane_count=2") &&
          warning.includes("remote_pane_ids=41,42") &&
          warning.includes("pane_labels=1,2") &&
          warning.includes("error_code=invalid_payload") &&
          warning.includes("duplicate or invalid paneLabel in surface payload")
        ),
      );
    });
  });

  await t.test("surfaces.list removes an established surface missing from the authoritative list", async () => {
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
      assert.equal(staleSurface.stopRequested, true);
      assert.equal(internalRuntime.surfaces.has("sf_stale-window"), false);
      assert.equal(internalRuntime.surfaces.get(server.surfaceId), preservedSurface);
      assert.ok(internalRuntime.surfaces.get("sf_surface-b"));
    });
  });

  await t.test("endpoint reconciliation preserves every live surface on a multi-window endpoint", async () => {
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
        assert.equal(surface.endpointId, `endpoint-${port}`);
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

  await t.test("surface appeared for an already listed canonical sibling does not duplicate the visible registry", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-surface-appeared-duplicate-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() =>
        server.pairedSocketFor("sf_surface-a") !== null &&
        server.pairedSocketFor("sf_surface-b") !== null,
      );

      server.sendSurfaceAppeared({
        initialRemotePaneId: 42,
        name: "Surface B",
        surfaceId: "sf_surface-b",
      });

      await waitFor(async () => (await runtime.listScreens()).length === 2);

      const internalRuntime = runtime as any;
      assert.deepEqual(
        (await runtime.listScreens()).map((screen) => screen.fingerprint),
        ["sf_surface-a", "sf_surface-b"],
      );
      assert.deepEqual(
        [...internalRuntime.surfaces.keys()].sort(),
        ["sf_surface-a", "sf_surface-b"],
      );
      assert.equal(internalRuntime.endpointProbes.size, 1);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("surfaces.list absence removes a closed sibling window even if the lifecycle event was missed", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-missed-surface-remove-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      let surfaceBScreen = (await runtime.listScreens()).find((screen) => screen.fingerprint === "sf_surface-b");
      await waitFor(async () => {
        surfaceBScreen = (await runtime.listScreens()).find((screen) => screen.fingerprint === "sf_surface-b");
        return Boolean(surfaceBScreen);
      });

      const paneId = surfaceBScreen!.panes[0]!.paneId;
      await runtime.push(
        {
          content: "<p>closed window content</p>",
          contentType: "html",
          fingerprint: "sf_surface-b",
          paneId,
        },
        { sessionDisplayName: "Session B", sessionKey: "agent:test:surface-b" },
      );
      const internalRuntime = runtime as any;
      assert.ok(internalRuntime.persistentState.targetStateBySurfaceId["sf_surface-b"]);

      server.removeSurfaceWithoutEvent("sf_surface-b");
      const primarySurface = internalRuntime.surfaces.get("sf_surface-a");
      assert.ok(primarySurface);
      await internalRuntime.discoverSurfaceId(primarySurface);

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          !screens.some((screen) => screen.fingerprint === "sf_surface-b") &&
          server.pairedSocketFor("sf_surface-b") === null &&
          !internalRuntime.persistentState.targetStateBySurfaceId["sf_surface-b"]
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

  await t.test("surfaces.list absence removes the queried source surface", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-source-surface-absent-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return screens.some((screen) => screen.fingerprint === "sf_surface-b");
      });

      const internalRuntime = runtime as any;
      const sourceSurface = internalRuntime.surfaces.get("sf_surface-b");
      assert.ok(sourceSurface);
      server.omitSurfaceFromList("sf_surface-b");
      await internalRuntime.discoverSurfaceId(sourceSurface);

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          !screens.some((screen) => screen.fingerprint === "sf_surface-b") &&
          server.pairedSocketFor("sf_surface-b") === null
        );
      });
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("source removal still starts newly discovered sibling windows", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-source-removed-start-sibling-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => server.pairedSocketFor("sf_surface-a") !== null);

      server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
      server.omitSurfaceFromList("sf_surface-a");

      const internalRuntime = runtime as any;
      const sourceSurface = internalRuntime.surfaces.get("sf_surface-a");
      assert.ok(sourceSurface?.client);
      await sourceSurface.client.close(1000, "test_source_removed_start_sibling");

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          server.pairedSocketFor("sf_surface-b") !== null &&
          screens.some((screen) => screen.fingerprint === "sf_surface-b") &&
          !screens.some((screen) => screen.fingerprint === "sf_surface-a")
        );
      }, 12_000);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("empty surfaces.list removes all cached surfaces for the endpoint", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-empty-surfaces-list-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return screens.some((screen) => screen.fingerprint === "sf_surface-a");
      });

      const internalRuntime = runtime as any;
      const sourceSurface = internalRuntime.surfaces.get("sf_surface-a");
      assert.ok(sourceSurface);
      server.omitSurfaceFromList("sf_surface-a");
      await internalRuntime.discoverSurfaceId(sourceSurface);

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return screens.length === 0 && server.pairedSocketFor("sf_surface-a") === null;
      });
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("empty surfaces.list prevents provisional endpoint resurrection", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-empty-list-no-provisional-"));
    const endpoint = discoveryEndpoint(port);
    const discovery = new StaticDiscoveryService([endpoint]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return screens.some((screen) => screen.fingerprint === "sf_surface-a");
      });

      const internalRuntime = runtime as any;
      const sourceSurface = internalRuntime.surfaces.get("sf_surface-a");
      assert.ok(sourceSurface);
      server.omitSurfaceFromList("sf_surface-a");
      await internalRuntime.discoverSurfaceId(sourceSurface);

      await waitFor(async () => (await runtime.listScreens()).length === 0);
      assert.deepEqual([...internalRuntime.surfaces.keys()], []);
      assert.equal(internalRuntime.endpointProbes.size, 1);
      const probe = internalRuntime.endpointProbes.get(endpoint.endpointId);
      assert.ok(probe);
      assert.equal("surfaceId" in probe, false);
      assert.equal("panes" in probe, false);
      await assert.rejects(
        runtime.read({
          fingerprint: endpoint.endpointId,
          paneId: "pn_probe" as any,
        }),
        /Unknown Surf Ace surface/,
      );

      internalRuntime.handleDiscoveryUpdate([endpoint]);
      assert.deepEqual(await runtime.listScreens(), []);

      await runtime.stop();
      const runtimeAfterRestart = createSurfAceRuntime({
        discovery: new StaticDiscoveryService([endpoint]),
        stateDir,
      });
      try {
        await runtimeAfterRestart.start();
        await waitFor(async () => (await runtimeAfterRestart.listScreens()).length === 0);

        server.addSurface({
          initialRemotePaneId: 42,
          name: "Reopened Surface",
          surfaceId: "sf_surface-reopened",
        });
        (runtimeAfterRestart as any).handleDiscoveryUpdate([endpoint]);

        await waitFor(async () => {
          const screens = await runtimeAfterRestart.listScreens();
          return (
            server.pairedSocketFor("sf_surface-reopened") !== null &&
            screens.some((screen) => screen.fingerprint === "sf_surface-reopened") &&
            !screens.some((screen) => screen.connectionState === "connecting")
          );
        }, 12_000);
      } finally {
        await runtimeAfterRestart.stop();
      }
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("last surface_removed event leaves only a hidden endpoint probe", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-last-surface-removed-probe-"));
    const endpoint = discoveryEndpoint(port);
    const discovery = new StaticDiscoveryService([endpoint]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return screens.some((screen) => screen.fingerprint === "sf_surface-a");
      });
      const paneId = await livePaneId(runtime, "sf_surface-a", 1);
      await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: "sf_surface-a",
        paneId,
      });
      const topologyApplyCountAfterSplit = server.topologyApplyRequests.length;

      server.sendSurfaceRemoved({ surfaceId: "sf_surface-a" });
      await waitFor(async () => (await runtime.listScreens()).length === 0);

      const internalRuntime = runtime as any;
      internalRuntime.handleDiscoveryUpdate([endpoint]);
      assert.deepEqual(await runtime.listScreens(), []);

      server.addSurface({
        initialRemotePaneId: 42,
        name: "Reopened Surface",
        surfaceId: "sf_surface-reopened",
      });
      internalRuntime.handleDiscoveryUpdate([endpoint]);

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          server.pairedSocketFor("sf_surface-reopened") !== null &&
          screens.some((screen) => screen.fingerprint === "sf_surface-reopened") &&
          !screens.some((screen) => screen.fingerprint === "sf_surface-a") &&
          !screens.some((screen) => screen.connectionState === "connecting") &&
          server.topologyApplyRequests.length === topologyApplyCountAfterSplit
        );
      }, 12_000);
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
          { sessionDisplayName: "Session One", sessionKey: "agent:test:1" },
        );
        const second = await runtime.push(
          {
            content: "<p>second</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          { sessionDisplayName: "Session One", sessionKey: "agent:test:1" },
        );
        const third = await runtime.push(
          {
            content: "<p>third</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          { sessionDisplayName: "Session Two", sessionKey: "agent:test:2" },
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
        assert.deepEqual(
          server.contentSetRequests.map((request) => request.displayTitle),
          ["Session One", "Session One", "Session Two"],
        );
        assert.deepEqual(server.contentSetRequests[0]?.displayProvenance, {
          displayName: "Session One",
          sessionKey: "agent:test:1",
        });
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

  await t.test("provider uses explicit pusher provenance for display without raw id fallback", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.push(
        {
          content: "# stream",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        {
          agentId: "agent_raw_123",
          provenance: {
            agentId: "agent_nested",
            displayName: "Nested Display",
            sessionKey: "agent:test:nested",
            source: "openclaw",
            streamLabel: "Nested Stream",
          },
          sessionKey: "agent:test:raw-only",
          streamLabel: "Surf Ace Stream",
        },
      );
      await runtime.push(
        {
          content: "# raw",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        {
          agentId: "agent_raw_456",
          sessionKey: "agent:test:raw-only-2",
        },
      );

      assert.equal(server.contentSetRequests[0]?.displayTitle, "Nested Display");
      assert.deepEqual(server.contentSetRequests[0]?.displayProvenance, {
        agentId: "agent_raw_123",
        displayName: "Nested Display",
        sessionKey: "agent:test:raw-only",
        source: "openclaw",
        streamLabel: "Surf Ace Stream",
      });
      assert.equal(server.contentSetRequests[1]?.displayTitle, null);
      assert.deepEqual(server.contentSetRequests[1]?.displayProvenance, {
        agentId: "agent_raw_456",
        sessionKey: "agent:test:raw-only-2",
      });
    });
  });

  await t.test("provider uses nested pusher session keys for content ownership", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const first = await runtime.push(
        {
          content: "# alpha",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        {
          pushedBy: {
            displayName: "Alpha Stream",
            sessionKey: "agent:test:nested-alpha",
          },
        },
      );
      const second = await runtime.push(
        {
          content: "# beta",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        {
          sourceProvenance: {
            displayName: "Beta Stream",
            sessionKey: "agent:test:nested-beta",
          },
        },
      );

      assert.notEqual(first.contentId, second.contentId);
      assert.notEqual(
        server.contentSetRequests[0]?.historyOwnerToken,
        server.contentSetRequests[1]?.historyOwnerToken,
      );
      assert.deepEqual(
        server.contentSetRequests.map((request) => request.displayTitle),
        ["Alpha Stream", "Beta Stream"],
      );

      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.historySummary.backCount, 1);
      assert.equal(screens[0]?.panes[0]?.historySummary.visibleContentId, second.contentId);
    });
  });

  await t.test("provider skips immediate html snapshot sync while renderer is pending", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const snapshotCountBefore = server.snapshotRequests.length;
      server.nextContentApplyRenderStatus = "pending_renderer";

      const result = await runtime.push(
        {
          content: "<p>pending</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionDisplayName: "Pending Renderer", sessionKey: "agent:test:pending-renderer" },
      );

      assert.equal(result.paneId, firstPaneId);
      assert.equal(server.contentSetRequests.length, 1);
      assert.equal(server.snapshotRequests.length, snapshotCountBefore);
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

  await t.test("provider records generic pane targets and keeps diagnostic placeholders separate", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "terminal:btop:1",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.terminal_app.v1"],
          safeToLogFields: ["command", "args"],
          safetyClass: "process",
          summary: "btop",
        },
        targetKind: "terminal_app",
        targetPayload: {
          args: [],
          command: "btop",
          cwd: "/tmp",
          env: { TERM: "xterm-256color" },
          envPolicy: "explicit_allowlist",
          pty: true,
          restartPolicy: "restore_new_process",
        },
      });
      assert.equal(registered.status, "registered");
      const originalLineage = targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId).paneLineageId;

      const screensAfterRegister = await runtime.listScreens();
      const target = screensAfterRegister[0]?.panes[0]?.target;
      assert.equal(target?.targetKind, "terminal_app");
      assert.equal(target?.targetPolicy, "confirm");
      assert.equal(target?.blockedReason, null);
      assert.deepEqual(target?.targetPayload, { args: [], command: "btop" });

      const blocked = await runtime.restoreTarget({
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assert.equal(blocked.blockedReason, "restore_requires_confirmation");
      assert.equal(server.targetApplyRequests.length, 0);

      await runtime.push({
        content: "<p>btop should be here</p>",
        contentType: "html",
        diagnostic: {
          derivedFromTargetId: target?.targetId,
          kind: "placeholder",
          summary: "btop placeholder",
        },
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      const screensAfterPlaceholder = await runtime.listScreens();
      const targetAfterPlaceholder = screensAfterPlaceholder[0]?.panes[0]?.target;
      assert.equal(targetAfterPlaceholder?.targetKind, "terminal_app");
      assert.equal(targetAfterPlaceholder?.diagnosticContent?.kind, "placeholder");
      assert.equal(targetAfterPlaceholder?.diagnosticContent?.summary, "btop placeholder");

      const confirmed = await runtime.restoreTarget({
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assert.equal(confirmed.blockedReason, null);
      assert.equal(confirmed.evidence?.status, "applied");
      assert.deepEqual(server.targetApplyRequests, [
        {
          materialization: {
            op: "native_pane.host",
            overlaySet: {
              coordinateSpace: "surface_logical",
              regions: [
                {
                  captures: [],
                  kind: "native_pane",
                  paneId: firstPaneId,
                  paneInstanceId: targetAfterPlaceholder?.paneLineageId,
                  rect: { height: 768, width: 1024, x: 0, y: 0 },
                  regionId: `${firstPaneId}:${target?.targetId}`,
                  zIndex: 0,
                },
              ],
              revision: registered.targetEpoch,
              surfaceId: server.surfaceId,
              topologyEpoch: 1,
              windowId: "a",
            },
            panes: [
              {
                binding_id: `${firstPaneId}:${target?.targetId}`,
                content_id: target?.targetId,
                geometry: {
                  coordinateSpace: "compositor_logical",
                  geometryRevision: 2,
                  height: 768,
                  paneInstanceId: targetAfterPlaceholder?.paneLineageId,
                  surfaceEpoch: `${server.surfaceId}:1`,
                  topologyEpoch: 0,
                  width: 1024,
                  x: 0,
                  y: 0,
                },
                id: firstPaneId,
                process: {
                  args: [],
                  command: "btop",
                  cwd: "/tmp",
                  env: { TERM: "xterm-256color" },
                },
                revision: registered.targetEpoch,
                target: "terminal",
              },
            ],
          },
          ownershipEpoch: targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId).ownershipEpoch,
          ownershipSessionId: targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId).ownershipSessionId,
          paneLineageId: targetAfterPlaceholder?.paneLineageId,
          restoreReason: "confirmed_restore",
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "launch_equivalent",
            requiredCapabilities: ["target.terminal_app.v1"],
            safeToLogFields: ["command", "args"],
            safetyClass: "process",
            summary: "btop",
          },
          targetId: target?.targetId,
          targetKind: "terminal_app",
          targetPayload: {
            args: [],
            command: "btop",
            cwd: "/tmp",
            env: { TERM: "xterm-256color" },
            envPolicy: "explicit_allowlist",
            pty: true,
            restartPolicy: "restore_new_process",
          },
        },
      ]);
      const screensAfterRestore = await runtime.listScreens();
      assert.equal(screensAfterRestore[0]?.panes[0]?.target?.diagnosticContent, null);
    });
  });

  await t.test("provider blocks non-legacy stale lineage discovered during process target restore", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "terminal:btop:stale-lineage",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        restorePolicy: "manual",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.terminal_app.v1"],
          safeToLogFields: ["command", "args"],
          safetyClass: "process",
          summary: "btop",
        },
        targetKind: "terminal_app",
        targetPayload: {
          args: [],
          command: "btop",
          cwd: "/tmp",
          env: { TERM: "xterm-256color" },
          envPolicy: "explicit_allowlist",
          pty: true,
          restartPolicy: "restore_new_process",
        },
      });
      assert.equal(registered.status, "registered");
      const originalLineage = targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId).paneLineageId;

      const serverPane = server.panes.get(server.initialRemotePaneId);
      assert.ok(serverPane);
      serverPane.paneLineageId = `pl_${server.surfaceId}_recreated`;

      const restored = await runtime.restoreTarget({
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      assert.equal(restored.blockedReason, "restore_blocked_stale_target");
      assert.equal(restored.evidence, null);
      assert.equal(server.targetApplyRequests.length, 0);
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const staleTarget = [...surface.targetRecords.values()].find((record: any) => record.paneLineageId === originalLineage);
      assert.equal(staleTarget?.currentState, "stale");
      assert.equal(staleTarget?.lastApplyEvidence, undefined);
      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.target?.blockedReason, "restore_blocked_stale_target");
      assert.equal(screens[0]?.panes[0]?.target?.paneLineageId, originalLineage);
    });
  });

  await t.test("surf_ace_push browser_url creates a live URL target instead of static HTML", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        const pushed = await runtime.push(
          {
            content: "https://google.com",
            contentType: "browser_url",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          {
            pushedBy: {
              displayName: "Browser Pusher",
              sessionKey: "agent:test:browser",
              source: "openclaw",
            },
          },
        );

        assert.equal(pushed.contentId, null);
        assert.equal(pushed.targetKind, "browser_url");
        assert.equal(pushed.targetApplyEvidence?.status, "applied");
        assert.equal(pushed.revision, 1);
        assert.equal(server.contentSetRequests.length, 0);
        assert.equal(server.targetApplyRequests.length, 1);
        const [applyRequest] = server.targetApplyRequests;
        assert.ok(applyRequest);
        assert.equal(applyRequest.materialization, undefined);
        assert.equal(applyRequest.displayTitle, "Browser Pusher");
        assert.deepEqual(applyRequest.displayProvenance, {
          displayName: "Browser Pusher",
          sessionKey: "agent:test:browser",
          source: "openclaw",
        });
        assert.equal(applyRequest.restoreReason, "initial_apply");
        assert.equal(applyRequest.targetKind, "browser_url");
        assert.deepEqual(applyRequest.targetHeader, {
          payloadSchemaVersion: 1,
          replaySemantics: "navigate",
          requiredCapabilities: ["target.browser_url.v1"],
          safeToLogFields: ["url"],
          safetyClass: "network",
          summary: "https://google.com",
        });
        assert.deepEqual(applyRequest.targetPayload, { url: "https://google.com" });

        const screens = await runtime.listScreens();
        const target = screens[0]?.panes[0]?.target;
        assert.equal(target?.targetKind, "browser_url");
        assert.equal(target?.targetPolicy, "confirm");
        assert.equal(target?.display?.title, "Browser Pusher");
        assert.deepEqual(target?.targetPayload, { url: "https://google.com" });

        await runtime.push({
          content: "<p>replacement</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(server.contentSetRequests.at(-1)?.revision, pushed.revision + 1);
      },
    });
  });

  await t.test("surf_ace_list clears browser_url target metadata when native hosting supersedes it", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        await runtime.push({
          content: "https://google.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const remotePane = server.panes.get(server.initialRemotePaneId);
        assert.ok(remotePane);
        remotePane.contentId = null;
        remotePane.contentType = null;
        remotePane.externalNative = true;
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        await internalRuntime.syncRemotePaneList(surface);

        const screensAfterNative = await runtime.listScreens();
        assert.equal(screensAfterNative[0]?.panes[0]?.activeContent, null);
        assert.equal(screensAfterNative[0]?.panes[0]?.target, null);
      },
    });
  });

  await t.test("browser_url target apply keeps content revisions monotonic after prior pushes", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        await runtime.push({
          content: "",
          contentType: "canvas",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        const secondPush = await runtime.push({
          content: "",
          contentType: "canvas",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const browserPush = await runtime.push({
          content: "https://google.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(browserPush.revision, secondPush.revision);

        await runtime.push({
          content: "<p>replacement</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(server.contentSetRequests.at(-1)?.revision, secondPush.revision + 1);
      },
    });
  });

  await t.test("content.apply resyncs provider revision from client stale_revision and retries once", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.nextContentApplyError = {
          code: "stale_revision",
          details: { expectedRevision: 4 },
          message: "Expected revision >= 4",
        };
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        const pushed = await runtime.push({
          content: "<p>resynced</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(pushed.revision, 5);
        assert.deepEqual(
          server.contentSetRequests.map((request) => request.revision),
          [5],
        );
        const screens = await runtime.listScreens();
        assert.equal(screens[0]?.panes[0]?.activeContent?.revision, 5);
      },
    });
  });

  await t.test("content.clear resyncs provider revision from client stale_revision and retries once", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.nextContentApplyError = {
          code: "stale_revision",
          details: { expectedRevision: 4 },
          message: "Expected revision >= 4",
        };
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const cleared = await runtime.clear({
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(cleared.revision, 5);
        assert.deepEqual(
          server.clearRequests.map((request) => request.revision),
          [5],
        );
        const screens = await runtime.listScreens();
        assert.equal(screens[0]?.panes[0]?.activeContent, null);
      },
    });
  });

  await t.test("surf_ace_list repairs legacy provider pane lineage before browser_url target.apply", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.includePairPaneLineageIds = false;
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        const pushed = await runtime.push({
          content: "https://arstechnica.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(pushed.targetApplyEvidence?.status, "applied");
        const [applyRequest] = server.targetApplyRequests;
        assert.ok(applyRequest);
        assert.equal(applyRequest.paneLineageId, `pl_${server.surfaceId}_${server.initialRemotePaneId}`);
        assert.doesNotMatch(applyRequest.paneLineageId, /^legacy_remote_pane_/);
        const screens = await runtime.listScreens();
        assert.equal(
          screens[0]?.panes[0]?.target?.paneLineageId,
          `pl_${server.surfaceId}_${server.initialRemotePaneId}`,
        );
      },
    });
  });

  await t.test("provider does not migrate legacy target lineage by pane label or pane id alone", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        const currentLineage = pane.paneLineageId;
        const legacyLineage = `legacy_remote_pane_${server.initialRemotePaneId}`;
        const targetId = "tgt_legacy_label_only";
        surface.targetRecords.set(targetId, {
          appliedAt: new Date().toISOString(),
          currentState: "current",
          ownerProviderId: internalRuntime.persistentState.providerId,
          ownershipEpoch: surface.ownershipEpoch,
          ownershipSessionId: surface.sessionId,
          paneIdAtApply: pane.paneId,
          paneLabelAtApply: pane.paneLabel,
          paneLineageId: legacyLineage,
          restorePolicy: "auto",
          surfaceId: surface.surfaceId,
          surfaceInstanceId: null,
          targetEpoch: pane.targetEpoch + 1,
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "navigate",
            requiredCapabilities: ["target.browser_url.v1"],
            safeToLogFields: ["url"],
            safetyClass: "network",
            summary: "legacy label-only target",
          },
          targetId,
          targetKind: "browser_url",
          targetPayload: { url: "https://example.com/legacy" },
        });
        pane.paneLineageId = legacyLineage;
        pane.currentTargetId = null;
        pane.staleTargetId = null;

        internalRuntime.adoptPaneLineage(surface, pane, currentLineage);

        const target = surface.targetRecords.get(targetId);
        assert.equal(target?.paneLineageId, legacyLineage);
        assert.equal(target?.currentState, "stale");
        assert.equal(pane.currentTargetId, null);
        assert.equal(server.targetApplyRequests.length, 0);
      },
    });
  });

  await t.test("provider marks current target stale when non-legacy pane lineage changes", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        await runtime.push({
          content: "https://example.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(server.targetApplyRequests.length, 1);

        const remotePane = server.panes.get(server.initialRemotePaneId);
        assert.ok(remotePane);
        remotePane.paneLineageId = `pl_${server.surfaceId}_${server.initialRemotePaneId}_reset`;

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        await internalRuntime.syncRemotePaneList(surface);

        const screen = (await runtime.listScreens())[0];
        const pane = screen?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(pane?.target?.blockedReason, "restore_blocked_stale_target");
        assert.equal(pane?.target?.targetKind, "browser_url");
        assert.equal(server.targetApplyRequests.length, 1);

        const staleTarget = [...surface.targetRecords.values()].find((record: any) => record.targetKind === "browser_url");
        assert.equal(staleTarget?.currentState, "stale");
        assert.equal(surface.panes.get(firstPaneId)?.currentTargetId, null);
        assert.equal(surface.panes.get(firstPaneId)?.targetEpoch, 0);

        internalRuntime.captureSurfaceTargetState(surface);
        surface.targetRecords = new Map();
        surface.panes.get(firstPaneId).staleTargetId = null;
        surface.panes.get(firstPaneId).lastRestoreBlockedReason = null;
        internalRuntime.hydrateSurfaceTargetState(surface, true);

        const rehydratedPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(rehydratedPane?.target?.blockedReason, "restore_blocked_stale_target");
        assert.equal(rehydratedPane?.target?.targetKind, "browser_url");

        const registered = await runtime.registerTarget({
          expectedPreviousTargetEpoch: null,
          fingerprint: server.surfaceId,
          idempotencyKey: "terminal:new-lineage",
          ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
          paneId: firstPaneId,
          registrationState: "attached",
          restorePolicy: "manual",
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "launch_equivalent",
            requiredCapabilities: ["target.terminal_app.v1"],
            safeToLogFields: ["command"],
            safetyClass: "process",
            summary: "new lineage target",
          },
          targetKind: "terminal_app",
          targetPayload: {
            args: [],
            command: "top",
            envPolicy: "surface_default",
            pty: true,
            restartPolicy: "restore_new_process",
          },
        });
        assert.equal(registered.status, "registered");
      },
    });
  });

  await t.test("provider invalidates current targets when ownership epoch changes", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        await runtime.push({
          content: "https://example.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(server.targetApplyRequests.length, 1);

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        internalRuntime.markPairConnected(surface, "sa_reowned_session", false);

        const pane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(pane?.target?.blockedReason, "ownership_epoch_mismatch");
        assert.equal(pane?.target?.targetKind, "browser_url");
        assert.equal(server.targetApplyRequests.length, 1);

        const staleTarget = [...surface.targetRecords.values()].find((record: any) => record.targetKind === "browser_url");
        assert.equal(staleTarget?.currentState, "stale");
        assert.equal(surface.panes.get(firstPaneId)?.currentTargetId, null);

        internalRuntime.captureSurfaceTargetState(surface);
        surface.targetRecords = new Map();
        surface.panes.get(firstPaneId).staleTargetId = null;
        surface.panes.get(firstPaneId).lastRestoreBlockedReason = null;
        internalRuntime.hydrateSurfaceTargetState(surface, true);

        const rehydratedPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(rehydratedPane?.target?.blockedReason, "ownership_epoch_mismatch");
        assert.equal(rehydratedPane?.target?.targetKind, "browser_url");
      },
    });
  });

  await t.test("provider does not attach stale persisted targets by pane label or pane id", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        await runtime.push({
          content: "https://example.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const target = [...surface.targetRecords.values()].find((record: any) => record.targetKind === "browser_url");
        assert.ok(target);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        const staleLineage = `${pane.paneLineageId}_old`;
        target.paneLineageId = staleLineage;
        target.paneIdAtApply = pane.paneId;
        target.paneLabelAtApply = pane.paneLabel;
        surface.targetRecords.set(target.targetId, target);
        internalRuntime.persistentState.targetStateBySurfaceId = {
          [server.surfaceId]: {
            ownershipEpoch: surface.ownershipEpoch,
            paneTargets: {
              [staleLineage]: {
                currentTargetId: target.targetId,
                diagnosticContent: null,
                lastRestoreBlockedReason: null,
                nonDurableTargetDiagnostic: null,
                paneLineageId: staleLineage,
                targetEpoch: target.targetEpoch,
              },
            },
            registeredTargetIdsByIdempotencyKey: {},
            targetRecords: [structuredClone(target)],
          },
        };

        internalRuntime.hydrateSurfaceTargetState(surface, true);

        const refreshedPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(refreshedPane?.target, null);
        const hydratedTarget = surface.targetRecords.get(target.targetId);
        assert.equal(hydratedTarget?.currentState, "stale");
        assert.equal(surface.panes.get(firstPaneId)?.staleTargetId, null);
        internalRuntime.captureSurfaceTargetState(surface);
        assert.equal(
          internalRuntime.persistentState.targetStateBySurfaceId[server.surfaceId].targetRecords.some(
            (record: any) => record.targetId === target.targetId && record.currentState === "stale",
          ),
          true,
        );
        assert.equal(server.targetApplyRequests.length, 1);
      },
    });
  });

  await t.test("surf_ace_push browser_url blocks when the surface lacks live browser capability", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const panesListRequestsBeforePush = server.panesListRequests;
      const topologyApplyRequestsBeforePush = server.topologyApplyRequests.length;

      await assert.rejects(
        async () => await runtime.push({
          content: "https://google.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        }),
        /target\.browser_url\.v1/,
      );
      assert.equal(server.contentSetRequests.length, 0);
      assert.equal(server.targetApplyRequests.length, 0);
      assert.equal(server.panesListRequests, panesListRequestsBeforePush);
      assert.equal(server.topologyApplyRequests.length, topologyApplyRequestsBeforePush);
    });
  });

  await t.test("surf_ace_push browser_url keeps failed materialization as target evidence", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
        server.targetApplyErrorCode = "materialization_failed";
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        const pushed = await runtime.push({
          content: "https://blocked.invalid/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(pushed.contentId, null);
        assert.equal(pushed.blockedReason, "materialization_failed");
        assert.equal(pushed.targetApplyEvidence?.status, "failed");
        assert.equal(pushed.targetApplyEvidence?.errorCode, "materialization_failed");
        const screens = await runtime.listScreens();
        const target = screens[0]?.panes[0]?.target;
        assert.equal(target?.targetKind, "browser_url");
        assert.equal(target?.blockedReason, "materialization_failed");
        assert.equal(target?.lastApplyEvidence?.status, "failed");
      },
    });
  });

  await t.test("surf_ace_push browser_url marks ownership mismatch target stale at provider boundary", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
        server.targetApplyResultErrorCode = "ownership_epoch_mismatch";
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        const pushed = await runtime.push({
          content: "http://100.85.66.60:18803/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(pushed.blockedReason, "ownership_epoch_mismatch");
        assert.equal(pushed.targetApplyEvidence?.errorCode, "ownership_epoch_mismatch");
        assert.equal(server.targetApplyRequests.length, 1);

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        assert.equal(pane.currentTargetId, null);
        assert.equal(pane.lastRestoreBlockedReason, "ownership_epoch_mismatch");
        const staleTarget = pane.staleTargetId ? surface.targetRecords.get(pane.staleTargetId) : null;
        assert.equal(staleTarget?.currentState, "stale");
        assert.equal(staleTarget?.lastApplyEvidence?.errorCode, "ownership_epoch_mismatch");

        const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(screenPane?.target?.blockedReason, "ownership_epoch_mismatch");
        assert.equal(screenPane?.target?.lastApplyEvidence?.errorCode, "ownership_epoch_mismatch");
      },
    });
  });

  await t.test("provider sends current split pane geometry in native pane materialization", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const [, secondPane] = split;
      assert.ok(secondPane);
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "terminal:btop:split-pane",
        ...targetRegistrationOwnership(runtime, server.surfaceId, secondPane.paneId),
        paneId: secondPane.paneId,
        registrationState: "attached",
        restorePolicy: "manual",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.terminal_app.v1"],
          safeToLogFields: ["command", "args"],
          safetyClass: "process",
          summary: "btop split",
        },
        targetKind: "terminal_app",
        targetPayload: {
          args: ["--utf-force"],
          command: "btop",
          envPolicy: "surface_default",
          pty: true,
          restartPolicy: "restore_new_process",
        },
      });
      assert.equal(registered.status, "registered");

      const restored = await runtime.restoreTarget({
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: secondPane.paneId,
      });
      assert.equal(restored.blockedReason, null);
      assert.equal(server.targetApplyRequests.length, 1);

      const [applyRequest] = server.targetApplyRequests;
      assert.ok(applyRequest);
      assert.deepEqual(applyRequest.materialization, {
        op: "native_pane.host",
        overlaySet: {
          coordinateSpace: "surface_logical",
          regions: [
            {
              captures: [],
              kind: "native_pane",
              paneId: secondPane.paneId,
              paneInstanceId: applyRequest.paneLineageId,
              rect: { height: 384, width: 1024, x: 0, y: 384 },
              regionId: `${secondPane.paneId}:${registered.targetId}`,
              zIndex: 1,
            },
          ],
          revision: registered.targetEpoch,
          surfaceId: server.surfaceId,
          topologyEpoch: 2,
          windowId: "a",
        },
        panes: [
          {
            binding_id: `${secondPane.paneId}:${registered.targetId}`,
            content_id: registered.targetId,
            geometry: {
              coordinateSpace: "compositor_logical",
              geometryRevision: 3,
              height: 384,
              paneInstanceId: applyRequest.paneLineageId,
              surfaceEpoch: `${server.surfaceId}:1`,
              topologyEpoch: 1,
              width: 1024,
              x: 0,
              y: 384,
            },
            id: secondPane.paneId,
            process: { args: ["--utf-force"], command: "btop" },
            revision: registered.targetEpoch,
            target: "terminal",
          },
        ],
      });
    });
  });

  await t.test("provider uses rotated logical surface dimensions for native pane geometry", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.addSurface({
          surfaceId: server.surfaceId,
          viewport: { height: 3840, scale: 1, width: 2160 },
        });
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const registered = await runtime.registerTarget({
          expectedPreviousTargetEpoch: null,
          fingerprint: server.surfaceId,
          idempotencyKey: "terminal:top:racter-deg90-logical",
          ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
          paneId: firstPaneId,
          registrationState: "attached",
          restorePolicy: "manual",
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "launch_equivalent",
            requiredCapabilities: ["target.terminal_app.v1"],
            safeToLogFields: ["command", "args"],
            safetyClass: "process",
            summary: "top deg90",
          },
          targetKind: "terminal_app",
          targetPayload: {
            args: [],
            command: "top",
            envPolicy: "surface_default",
            pty: true,
            restartPolicy: "restore_new_process",
          },
        });
        assert.equal(registered.status, "registered");

        const restored = await runtime.restoreTarget({
          confirmed: true,
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(restored.blockedReason, null);
        assert.equal(server.targetApplyRequests.length, 1);

        const [applyRequest] = server.targetApplyRequests;
        assert.ok(applyRequest);
        assert.deepEqual(applyRequest.materialization, {
          op: "native_pane.host",
          overlaySet: {
            coordinateSpace: "surface_logical",
            regions: [
              {
                captures: [],
                kind: "native_pane",
                paneId: firstPaneId,
                paneInstanceId: applyRequest.paneLineageId,
                rect: { height: 3840, width: 2160, x: 0, y: 0 },
                regionId: `${firstPaneId}:${registered.targetId}`,
                zIndex: 0,
              },
            ],
            revision: registered.targetEpoch,
            surfaceId: server.surfaceId,
            topologyEpoch: 1,
            windowId: "a",
          },
          panes: [
            {
              binding_id: `${firstPaneId}:${registered.targetId}`,
              content_id: registered.targetId,
              geometry: {
                coordinateSpace: "compositor_logical",
                geometryRevision: 2,
                height: 3840,
                paneInstanceId: applyRequest.paneLineageId,
                surfaceEpoch: `${server.surfaceId}:1`,
                topologyEpoch: 0,
                width: 2160,
                x: 0,
                y: 0,
              },
              id: firstPaneId,
              process: { args: [], command: "top" },
              revision: registered.targetEpoch,
              target: "terminal",
            },
          ],
        });
      },
    });
  });

  await t.test("provider includes pane geometry for native app target materialization", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "native:demo:geometry",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        restorePolicy: "manual",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.native_app.v1"],
          safeToLogFields: ["appId"],
          safetyClass: "process",
          summary: "Native Demo",
        },
        targetKind: "native_app",
        targetPayload: {
          appId: "com.example.NativeDemo",
          launchMode: "new_instance",
        },
      });
      assert.equal(registered.status, "registered");

      const restored = await runtime.restoreTarget({
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assert.equal(restored.blockedReason, null);
      assert.equal(server.targetApplyRequests.length, 1);

      const [applyRequest] = server.targetApplyRequests;
      assert.ok(applyRequest);
      assert.deepEqual(applyRequest.materialization, {
        op: "native_pane.host",
        overlaySet: {
          coordinateSpace: "surface_logical",
          regions: [
            {
              captures: [],
              kind: "native_pane",
              paneId: firstPaneId,
              paneInstanceId: applyRequest.paneLineageId,
              rect: { height: 768, width: 1024, x: 0, y: 0 },
              regionId: `${firstPaneId}:${registered.targetId}`,
              zIndex: 0,
            },
          ],
          revision: registered.targetEpoch,
          surfaceId: server.surfaceId,
          topologyEpoch: 1,
          windowId: "a",
        },
        panes: [
          {
            binding_id: `${firstPaneId}:${registered.targetId}`,
            content_id: registered.targetId,
            geometry: {
              coordinateSpace: "compositor_logical",
              geometryRevision: 2,
              height: 768,
              paneInstanceId: applyRequest.paneLineageId,
              surfaceEpoch: `${server.surfaceId}:1`,
              topologyEpoch: 0,
              width: 1024,
              x: 0,
              y: 0,
            },
            id: firstPaneId,
            revision: registered.targetEpoch,
          },
        ],
      });
    });
  });

  await t.test("provider rejects duplicate and stale local target registrations without incrementing epoch", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const input = {
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "native:app:1",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached" as const,
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent" as const,
          requiredCapabilities: ["target.native_app.v1"],
          safeToLogFields: ["appId"],
          safetyClass: "process" as const,
          summary: "Native App",
        },
        targetKind: "native_app" as const,
        targetPayload: {
          appId: "com.example.Native",
          launchMode: "new_instance",
        },
      };
      const first = await runtime.registerTarget(input);
      const duplicate = await runtime.registerTarget(input);
      assert.equal(first.status, "registered");
      assert.deepEqual(duplicate, first);

      const stale = await runtime.registerTarget({
        ...input,
        idempotencyKey: "native:app:stale",
        targetPayload: {
          appId: "com.example.Other",
          launchMode: "new_instance",
        },
      });
      assert.equal(stale.status, "rejected");
      assert.equal(stale.status === "rejected" ? stale.errorCode : "", "target_epoch_stale");

      const oldEpoch = await runtime.registerTarget({
        ...input,
        idempotencyKey: "native:app:old-epoch",
        ownershipEpoch: input.ownershipEpoch - 1,
      });
      assert.equal(oldEpoch.status, "rejected");
      assert.equal(oldEpoch.status === "rejected" ? oldEpoch.errorCode : "", "registration_late_old_epoch");

      await runtime.clear({
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const staleAfterTombstone = await runtime.registerTarget({
        ...input,
        idempotencyKey: "native:app:stale-after-tombstone",
      });
      assert.equal(staleAfterTombstone.status, "rejected");
      assert.equal(staleAfterTombstone.status === "rejected" ? staleAfterTombstone.errorCode : "", "target_epoch_stale");

      const malformed = await runtime.registerTarget({
        ...input,
        expectedPreviousTargetEpoch: first.status === "registered" ? first.targetEpoch : null,
        idempotencyKey: "native:app:malformed",
        targetPayload: {
          appId: "com.example.Malformed",
        },
      });
      assert.equal(malformed.status, "rejected");
      assert.equal(malformed.status === "rejected" ? malformed.errorCode : "", "unsafe_payload");

      const malformedImage = await runtime.registerTarget({
        expectedPreviousTargetEpoch: first.status === "registered" ? first.targetEpoch : null,
        fingerprint: server.surfaceId,
        idempotencyKey: "image:malformed",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "bytes",
          requiredCapabilities: ["target.image.v1"],
          safeToLogFields: ["mediaType", "alt"],
          safetyClass: "passive",
          summary: "Malformed Image",
        },
        targetKind: "image",
        targetPayload: {
          data: "aGVsbG8=",
        },
      });
      assert.equal(malformedImage.status, "rejected");
      assert.equal(malformedImage.status === "rejected" ? malformedImage.errorCode : "", "unsafe_payload");
    });
  });

  await t.test("provider does not return stale target records by idempotency key after ownership change", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const input = {
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "native:app:ownership-rerun",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached" as const,
        restorePolicy: "manual" as const,
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent" as const,
          requiredCapabilities: ["target.native_app.v1"],
          safeToLogFields: ["appId"],
          safetyClass: "process" as const,
          summary: "Native App",
        },
        targetKind: "native_app" as const,
        targetPayload: {
          appId: "com.example.Native",
          launchMode: "new_instance" as const,
        },
      };
      const first = await runtime.registerTarget(input);
      assert.equal(first.status, "registered");

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      internalRuntime.markPairConnected(surface, "sa_target_reowned_session", false);

      const rerunAfterOwnershipChange = await runtime.registerTarget({
        ...input,
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        expectedPreviousTargetEpoch: first.status === "registered" ? first.targetEpoch : null,
      });
      assert.equal(rerunAfterOwnershipChange.status, "registered");
      if (rerunAfterOwnershipChange.status === "registered") {
        assert.notEqual(rerunAfterOwnershipChange.targetId, first.targetId);
      }

      const staleTarget = surface.targetRecords.get(first.status === "registered" ? first.targetId : "");
      assert.equal(staleTarget?.currentState, "stale");
      assert.equal(
        surface.registeredTargetIdsByIdempotencyKey.get(input.idempotencyKey),
        rerunAfterOwnershipChange.status === "registered" ? rerunAfterOwnershipChange.targetId : null,
      );
    });
  });

  await t.test("provider normalizes generic target.apply failures for diagnostics", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      server.targetApplyErrorCode = "busy";
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "terminal:busy:1",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.terminal_app.v1"],
          safeToLogFields: ["command"],
          safetyClass: "process",
          summary: "busy terminal",
        },
        targetKind: "terminal_app",
        targetPayload: {
          args: [],
          command: "top",
          envPolicy: "surface_default",
          pty: true,
          restartPolicy: "restore_new_process",
        },
      });
      assert.equal(registered.status, "registered");

      const restored = await runtime.restoreTarget({
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assert.equal(restored.evidence?.status, "failed");
      assert.equal(restored.evidence?.errorCode, "materialization_failed");
      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.target?.blockedReason, "materialization_failed");
    });
  });

  await t.test("provider blocks process auto-restore without a validated approval token model", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "terminal:auto:approval-token-string",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        restorePolicy: "auto",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.terminal_app.v1"],
          safeToLogFields: ["command"],
          safetyClass: "process",
          summary: "top",
        },
        targetKind: "terminal_app",
        targetPayload: {
          approvalTokenId: "not-provider-validated",
          args: [],
          command: "top",
          envPolicy: "surface_default",
          pty: true,
          restartPolicy: "restore_new_process",
        },
      });
      assert.equal(registered.status, "registered");

      const restored = await runtime.restoreTarget({
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assert.equal(restored.blockedReason, "approval_required");
      assert.equal(server.targetApplyRequests.length, 0);
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
      assert.ok(
        server.topologyApplyRequests.some((request) => (
          JSON.stringify(request.layout) === JSON.stringify({
            children: [
              { paneId: server.initialRemotePaneId, type: "pane" },
              { paneId: 42, type: "pane" },
              { paneId: 43, type: "pane" },
            ],
            direction: "horizontal",
            type: "split",
          }) &&
          JSON.stringify(request.paneIds) === JSON.stringify([server.initialRemotePaneId, 42, 43]) &&
          JSON.stringify(request.paneLabels) === JSON.stringify([1, 2, 3]) &&
          request.windowLabel === "a"
        )),
      );

      const splitScreens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(splitScreens[0]?.panes ?? [], [1, 2, 3]);
      assert.deepEqual(
        splitScreens[0]?.panes.map((pane) => pane.viewport),
        [
          { height: 256, scale: 2, width: 1024 },
          { height: 256, scale: 2, width: 1024 },
          { height: 256, scale: 2, width: 1024 },
        ],
      );

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
        paneLabels: [1, 2],
        topologyRevision: server.topologyApplyRequests.at(-1)?.topologyRevision,
        windowLabel: "a",
      });

      const afterCloseScreens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(afterCloseScreens[0]?.panes ?? [], [1, 2]);
    });
  });

	  await t.test("provider realizes a desired root topology in one topology.apply", async () => {
	    await withRuntimeHarness(async ({ runtime, server }) => {
      const before = (await runtime.listScreens())[0]!;
      const firstPaneId = paneByLabel(before, 1).paneId;
      assert.deepEqual(before.topology, { paneId: firstPaneId, type: "pane" });
      assert.equal(before.topologyRevision, 0);

      const realized = await runtime.realizeTopology({
        allowDestroyPaneIds: [],
        desired: {
          children: [
            { paneId: firstPaneId, type: "pane" },
            { type: "pane" },
            { name: "scratch", type: "pane" },
          ],
          direction: "vertical",
          type: "split",
        },
        expectedTopologyRevision: before.topologyRevision,
        fingerprint: server.surfaceId,
        target: { root: true },
      });

      assert.deepEqual(server.splitRequests, []);
      assert.equal(server.topologyApplyRequests.length, 1);
      assert.deepEqual(server.topologyApplyRequests[0], {
        layout: {
          children: [
            { paneId: server.initialRemotePaneId, type: "pane" },
            { paneId: 42, type: "pane" },
            { paneId: 43, type: "pane" },
          ],
          direction: "vertical",
          type: "split",
        },
        paneIds: [server.initialRemotePaneId, 42, 43],
        paneLabels: [1, 2, 3],
        topologyRevision: 1,
        windowLabel: "a",
      });
      assert.deepEqual(realized.createdPaneIds.length, 2);
      assert.deepEqual(realized.destroyedPaneIds, []);
      assert.deepEqual(realized.preservedPaneIds, [firstPaneId]);
      assert.deepEqual(realized.panes.map((pane) => pane.paneLabel), [1, 2, 3]);
      assert.deepEqual(realized.topology, {
        children: [
          { paneId: firstPaneId, type: "pane" },
          { paneId: realized.createdPaneIds[0], type: "pane" },
          { paneId: realized.createdPaneIds[1], type: "pane" },
        ],
        direction: "vertical",
        type: "split",
      });

      const after = (await runtime.listScreens())[0]!;
      assert.deepEqual(after.topology, realized.topology);
      assert.equal(after.topologyRevision, 1);
      assertPaneLabelsWithOpaqueIds(after.panes, [1, 2, 3]);
	    });
	  });

	  await t.test("provider preserves compact pane labels when topology reorders surviving panes", async () => {
	    await withRuntimeHarness(async ({ runtime, server }) => {
	      const before = (await runtime.listScreens())[0]!;
	      const firstPaneId = paneByLabel(before, 1).paneId;
	      const split = await runtime.realizeTopology({
	        allowDestroyPaneIds: [],
	        desired: {
	          children: [
	            { paneId: firstPaneId, type: "pane" },
	            { type: "pane" },
	          ],
	          direction: "horizontal",
	          type: "split",
	        },
	        expectedTopologyRevision: before.topologyRevision,
	        fingerprint: server.surfaceId,
	        target: { root: true },
	      });
	      const labelOnePaneId = paneByLabel({ ...before, panes: split.panes }, 1).paneId;
	      const labelTwoPaneId = paneByLabel({ ...before, panes: split.panes }, 2).paneId;

	      const reordered = await runtime.realizeTopology({
	        allowDestroyPaneIds: [],
	        desired: {
	          children: [
	            { paneId: labelTwoPaneId, type: "pane" },
	            { paneId: labelOnePaneId, type: "pane" },
	          ],
	          direction: "horizontal",
	          type: "split",
	        },
	        expectedTopologyRevision: split.topologyRevision,
	        fingerprint: server.surfaceId,
	        target: { root: true },
	      });

	      assert.equal(paneByLabel({ ...before, panes: reordered.panes }, 1).paneId, labelOnePaneId);
	      assert.equal(paneByLabel({ ...before, panes: reordered.panes }, 2).paneId, labelTwoPaneId);
	      assert.deepEqual(server.topologyApplyRequests.at(-1)?.paneLabels, [2, 1]);
	    });
	  });

	  await t.test("provider realizes topology across multiple surfaces in one CLU operation", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.addSurface({
          initialRemotePaneId: 51,
          name: "Surface B",
          surfaceId: "sf_surface-b",
        });
      },
      run: async ({ runtime, server }) => {
        const before = await runtime.listScreens();
        const surfaceA = before.find((screen) => screen.fingerprint === server.surfaceId);
        const surfaceB = before.find((screen) => screen.fingerprint === "sf_surface-b");
        assert.ok(surfaceA);
        assert.ok(surfaceB);
        const paneA = surfaceA.panes[0]!;
        const paneB = surfaceB.panes[0]!;

        const realized = await runtime.realizeTopologies({
          operations: [
            {
              allowDestroyPaneIds: [],
              desired: {
                children: [{ paneId: paneA.paneId, type: "pane" }, { name: "A scratch", type: "pane" }],
                direction: "vertical",
                type: "split",
              },
              expectedTopologyRevision: surfaceA.topologyRevision,
              fingerprint: surfaceA.fingerprint,
              operationId: "surface-a",
              target: { root: true },
              windowLabel: surfaceA.windowLabel,
            },
            {
              allowDestroyPaneIds: [],
              desired: {
                children: [{ paneId: paneB.paneId, type: "pane" }, { name: "B scratch", type: "pane" }],
                direction: "vertical",
                type: "split",
              },
              expectedTopologyRevision: surfaceB.topologyRevision,
              fingerprint: surfaceB.fingerprint,
              operationId: "surface-b",
              target: { root: true },
              windowLabel: surfaceB.windowLabel,
            },
          ],
        });

        assert.equal(realized.ok, true);
        assert.deepEqual(realized.applied.map((result) => result.operationId), ["surface-a", "surface-b"]);
        assert.deepEqual(realized.applied.map((result) => result.fingerprint), [surfaceA.fingerprint, surfaceB.fingerprint]);
        assert.deepEqual(realized.applied.map((result) => result.createdPaneIds.length), [1, 1]);
        assert.equal(server.topologyApplyRequests.length, 2);

        const after = await runtime.listScreens();
        const afterA = after.find((screen) => screen.fingerprint === surfaceA.fingerprint);
        const afterB = after.find((screen) => screen.fingerprint === surfaceB.fingerprint);
        assert.equal(afterA?.panes.length, 2);
        assert.equal(afterB?.panes.length, 2);
        assert.equal(afterA?.topologyRevision, 1);
        assert.equal(afterB?.topologyRevision, 1);
      },
    });
  });

  await t.test("provider multi-surface topology reports clear partial failure", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.addSurface({
          initialRemotePaneId: 51,
          name: "Surface B",
          surfaceId: "sf_surface-b",
        });
      },
      run: async ({ runtime, server }) => {
        const before = await runtime.listScreens();
        const surfaceA = before.find((screen) => screen.fingerprint === server.surfaceId);
        const surfaceB = before.find((screen) => screen.fingerprint === "sf_surface-b");
        assert.ok(surfaceA);
        assert.ok(surfaceB);
        const result = await runtime.realizeTopologies({
          operations: [
            {
              allowDestroyPaneIds: [surfaceA.panes[0]!.paneId],
              desired: { children: [{ type: "pane" }, { type: "pane" }], direction: "vertical", type: "split" },
              expectedTopologyRevision: surfaceA.topologyRevision,
              fingerprint: surfaceA.fingerprint,
              operationId: "applies-first",
              target: { root: true },
            },
            {
              allowDestroyPaneIds: [],
              desired: { children: [{ type: "pane" }, { type: "pane" }], direction: "vertical", type: "split" },
              expectedTopologyRevision: surfaceB.topologyRevision + 1,
              fingerprint: surfaceB.fingerprint,
              operationId: "fails-second",
              target: { root: true },
            },
            {
              allowDestroyPaneIds: [],
              desired: { type: "pane" },
              expectedTopologyRevision: surfaceA.topologyRevision,
              fingerprint: surfaceA.fingerprint,
              operationId: "skipped-third",
              target: { root: true },
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.deepEqual(result.applied.map((applied) => applied.operationId), ["applies-first"]);
        assert.equal(result.failed.operationId, "fails-second");
        assert.equal(result.failed.index, 1);
        assert.equal(result.failed.code, "invalid_operation");
        assert.deepEqual(result.skipped.map((skipped) => skipped.operationId), ["skipped-third"]);

        const after = await runtime.listScreens();
        assert.equal(after.find((screen) => screen.fingerprint === surfaceA.fingerprint)?.topologyRevision, 1);
        assert.equal(after.find((screen) => screen.fingerprint === surfaceB.fingerprint)?.topologyRevision, 0);
      },
    });
  });

  await t.test("provider root realization removes allowed stale panes outside the current layout", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const before = (await runtime.listScreens())[0]!;
      const firstPaneId = paneByLabel(before, 1).paneId;
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const firstPane = surface.panes.get(firstPaneId);
      assert.ok(firstPane);
      const stalePaneId = "pn_stale_outside_layout";
      surface.panes.set(stalePaneId, {
        ...structuredClone(firstPane),
        paneId: stalePaneId,
        paneLabel: 99,
        remotePaneId: 999,
      });

      await assert.rejects(
        runtime.realizeTopology({
          allowDestroyPaneIds: [firstPaneId],
          desired: { type: "pane" },
          expectedTopologyRevision: before.topologyRevision,
          fingerprint: server.surfaceId,
          target: { root: true },
        }),
        /would destroy pane\(s\) pn_stale_outside_layout without allowDestroyPaneIds/,
      );

      const realized = await runtime.realizeTopology({
        allowDestroyPaneIds: [firstPaneId, stalePaneId],
        desired: {
          children: [{ type: "pane" }, { type: "pane" }],
          direction: "vertical",
          type: "split",
        },
        expectedTopologyRevision: before.topologyRevision,
        fingerprint: server.surfaceId,
        target: { root: true },
      });

      assert.deepEqual(realized.destroyedPaneIds.sort(), [firstPaneId, stalePaneId].sort());
      assert.equal(realized.panes.length, 2);
      assert.ok(!realized.panes.some((pane) => pane.paneId === stalePaneId));
      const after = (await runtime.listScreens())[0]!;
      assert.deepEqual(after.panes.map((pane) => pane.paneId).sort(), realized.createdPaneIds.sort());
    });
  });

  await t.test("provider pane-list sync ignores client stale panes outside provider-owned topology", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const before = (await runtime.listScreens())[0]!;
      const firstPaneId = paneByLabel(before, 1).paneId;
      const realized = await runtime.realizeTopology({
        allowDestroyPaneIds: [firstPaneId],
        desired: {
          children: [{ type: "pane" }, { type: "pane" }],
          direction: "vertical",
          type: "split",
        },
        expectedTopologyRevision: before.topologyRevision,
        fingerprint: server.surfaceId,
        target: { root: true },
      });
      const firstServerPane = server.panes.values().next().value as TestPane;
      server.panes.set(999, {
        ...structuredClone(firstServerPane),
        paneLabel: 999,
      });

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await internalRuntime.syncRemotePaneList(surface);

      const after = (await runtime.listScreens())[0]!;
      assert.deepEqual(after.panes.map((pane) => pane.paneId).sort(), realized.createdPaneIds.sort());
      assert.deepEqual(after.panes.map((pane) => pane.paneLabel), realized.panes.map((pane) => pane.paneLabel));
    });
  });

  await t.test("provider rejects stale or undeclared destructive topology realization before publish", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await assert.rejects(
        runtime.realizeTopology({
          allowDestroyPaneIds: [],
          desired: { paneId: firstPaneId, type: "pane" },
          expectedTopologyRevision: 99,
          fingerprint: server.surfaceId,
          target: { root: true },
        }),
        /expected revision 99, current revision is 0/,
      );

      await assert.rejects(
        runtime.realizeTopology({
          allowDestroyPaneIds: [],
          desired: { type: "pane" },
          expectedTopologyRevision: 0,
          fingerprint: server.surfaceId,
          target: { root: true },
        }),
        /would destroy pane/,
      );
      assert.equal(server.topologyApplyRequests.length, 0);
    });
  });

  await t.test("provider defaults omitted split direction from target pane geometry", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2]);
      assert.deepEqual(server.topologyApplyRequests.at(-1), {
        layout: {
          children: [
            { paneId: server.initialRemotePaneId, type: "pane" },
            { paneId: 42, type: "pane" },
          ],
          direction: "vertical",
          type: "split",
        },
        paneIds: [server.initialRemotePaneId, 42],
        paneLabels: [1, 2],
        topologyRevision: server.topologyApplyRequests.at(-1)?.topologyRevision,
        windowLabel: "a",
      });

      const splitScreens = await runtime.listScreens();
      assert.deepEqual(
        splitScreens[0]?.panes.map((pane) => pane.viewport),
        [
          { height: 768, scale: 2, width: 512 },
          { height: 768, scale: 2, width: 512 },
        ],
      );
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
        frame: { height: 768, width: 1024, x: 0, y: 0 },
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
      assert.deepEqual(repushed?.content, { html: "<p>first</p>" });

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

        const secondTopologyApply = server.topologyApplyRequests.at(-1);
        const secondRemotePaneId =
          secondTopologyApply?.paneIds[
            secondTopologyApply.paneLabels.findIndex((paneLabel) => paneLabel === 2)
          ];
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

  await t.test("surface resume sync skips restored panes without bound remote ids", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.push(
        {
          content: "# unbound restore",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:resume-unbound" },
      );

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const pane = surface.panes.get(firstPaneId);
      assert.ok(pane);
      pane.remotePaneId = undefined;

      const initialContentApplyCount = server.contentSetRequests.length;
      const initialSnapshotCount = server.snapshotRequests.length;
      internalRuntime.handleSurfaceResumedEvent(surface, {
        eventId: "ev_test_resume_unbound",
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

      assert.equal(server.contentSetRequests.length, initialContentApplyCount);
      assert.equal(server.snapshotRequests.length, initialSnapshotCount);
      assert.equal(
        warnings.some((warning) => warning.includes("paneId is required")),
        false,
      );
    });
  });

  await t.test("surface resume replays provider-owned content before snapshot sync", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "# restart continuity",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionDisplayName: "Resume Pusher", sessionKey: "agent:test:resume-continuity" },
      );

      const remotePane = server.panes.get(server.initialRemotePaneId);
      assert.ok(remotePane);
      remotePane.contentId = null;
      remotePane.contentType = null;
      remotePane.revision = 0;

      const initialContentApplyCount = server.contentSetRequests.length;
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      internalRuntime.handleSurfaceResumedEvent(surface, {
        eventId: "ev_test_resume_content",
        op: "event.surface_resumed",
        payload: {
          surfaceId: server.surfaceId,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      });

      await waitFor(() => server.contentSetRequests.length > initialContentApplyCount, 12_000);

      const replayed = server.contentSetRequests.at(-1);
      assert.equal(replayed?.contentId, pushed.contentId);
      assert.equal(replayed?.contentType, "markdown");
      assert.equal(replayed?.displayTitle, "Resume Pusher");
      assert.deepEqual(replayed?.displayProvenance, {
        displayName: "Resume Pusher",
        sessionKey: "agent:test:resume-continuity",
      });

      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.activeContent?.contentId, pushed.contentId);
      assert.equal(screens[0]?.panes[0]?.activeContent?.revision, pushed.revision);
    });
  });

  await t.test("persisted restart snapshot carries provider-owned content for replay", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "# persisted restart continuity",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:restart-persist" },
      );

      const internalRuntime = runtime as any;
      await internalRuntime.persistScreenSnapshot();
      const snapshotPath = path.join(internalRuntime.stateDir, "surf-ace-runtime-screens.json");
      const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as {
        contentContinuity?: Record<string, Array<{
          contentId: string;
          contentType: string;
          contentValue: string;
          paneLabel: number;
          revision: number;
          sessionKey: string | null;
        }>>;
      };
      const continuityEntry = snapshot.contentContinuity?.[server.surfaceId]?.[0];
      assert.equal(continuityEntry?.contentId, pushed.contentId);
      assert.equal(continuityEntry?.contentType, "markdown");
      assert.equal(continuityEntry?.contentValue, "# persisted restart continuity");
      assert.equal(continuityEntry?.paneLabel, 1);
      assert.equal(continuityEntry?.revision, pushed.revision);
      assert.equal(continuityEntry?.sessionKey, "agent:test:restart-persist");
    });
  });

  await t.test("restart content snapshot restores pane content before replay", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "# restored restart continuity",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:restart-restore" },
      );

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const pane = internalRuntime.firstPane(surface);
      assert.ok(pane);

      internalRuntime.clearVisiblePaneContent(pane, 0);
      internalRuntime.restartContentBySurface = new Map([
        [
          server.surfaceId,
          [
            {
              contentId: pushed.contentId,
              contentType: "markdown",
              contentValue: "# restored restart continuity",
              historyOwnerToken: "hot_test",
              paneLabel: pane.paneLabel,
              revision: pushed.revision,
              sessionKey: "agent:test:restart-restore",
            },
          ],
        ],
      ]);

      internalRuntime.restoreRestartContent(surface);

      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.activeContent?.contentId, pushed.contentId);
      assert.equal(screens[0]?.panes[0]?.activeContent?.revision, pushed.revision);
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

  await t.test("provider rejects pair responses without topology panes before marking connected", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.forceEmptyPairResponsePanes = true;
      },
      waitForPair: false,
      run: async ({ runtime, server, warnings }) => {
        await waitFor(
          () => warnings.some((warning) => warning.includes("contained no topology panes")),
          12_000,
        );

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        assert.equal(surface.hasPairedInGatewaySession, false);
        assert.equal(surface.sessionId, null);
        assert.notEqual(surface.connectionState, "connected");

        const screens = await runtime.listScreens();
        const screen = screens.find((entry) => entry.fingerprint === server.surfaceId);
        assert.ok(screen);
        assert.notEqual(screen.connectionState, "connected");
        assert.notEqual(screen.panes.length, 0);
      },
    });
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

  await t.test("known self-owned busy reconnect self-reclaims with stable provider identity", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      const initialProviderId = server.pairAttemptDetails[0]?.providerId;
      assert.equal(typeof initialProviderId, "string");
      server.busyWithoutTakeoverResponsesRemaining = 1;

      await surface.client.close(1000, "test_busy_self_reclaim_identity");

      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);

      const reconnectAttempts = server.pairAttemptDetails.slice(1);
      assert.deepEqual(
        reconnectAttempts.slice(0, 2).map((attempt) => attempt.providerId),
        [initialProviderId, initialProviderId],
      );
      assert.deepEqual(
        reconnectAttempts.slice(0, 2).map((attempt) => attempt.takeover),
        [false, true],
      );
      assert.ok(
        warnings.some((warning) => warning.includes("ownership_self_reclaim")),
      );
    });
  });

  await t.test("known self-owned invalid_resume reconnect self-reclaims with stable provider identity", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      const initialProviderId = server.pairAttemptDetails[0]?.providerId;
      assert.equal(typeof initialProviderId, "string");
      server.lockUntilNewProviderIdCode = "invalid_resume";
      server.lockUntilNewProviderIdProviderId = initialProviderId ?? null;

      await surface.client.close(1000, "test_invalid_resume_self_reclaim_identity");

      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);

      const reconnectAttempts = server.pairAttemptDetails.slice(1);
      assert.deepEqual(
        reconnectAttempts.slice(0, 2).map((attempt) => attempt.providerId),
        [initialProviderId, initialProviderId],
      );
      assert.deepEqual(
        reconnectAttempts.slice(0, 2).map((attempt) => attempt.takeover),
        [false, true],
      );
      assert.ok(
        warnings.some((warning) => warning.includes("ownership_self_reclaim")),
      );
    });
  });

  await t.test("connect refusal refresh does not rebind by single fingerprint prefix", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server, warnings }) => {
      const replacementPort = nextPort++;
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const originalEndpointId = surface.endpointId;
      const sharedFingerprint = surface.fingerprintPrefix;
      assert.ok(sharedFingerprint);

      discovery.setEndpoints([discoveryEndpoint(replacementPort, sharedFingerprint)]);
      await internalRuntime.refreshEndpointAfterConnectFailure(surface, new Error("ECONNREFUSED"));

      assert.equal(surface.endpointId, originalEndpointId);
      assert.ok(
        warnings.some((warning) =>
          warning.includes("not refreshing stale endpoint") &&
          warning.includes("discovery-only") &&
          warning.includes("matched 1 endpoint")),
      );
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
        const originalEndpointId = originalSurface.endpointId;

        await originalSurface.client.close(1000, "test_endpoint_url_change_wake");
        await server.close();

        await waitFor(() => originalSurface.reconnectAttempt >= 1, 12_000);
        originalSurface.reconnectAttempt = 4;
        originalSurface.unreachableFailures = 3;

        internalRuntime.refreshEndpointTopology({
          ...discoveryEndpoint(replacementPort),
          endpointId: originalSurface.endpointId,
        });

        assert.equal(originalSurface.endpointId, originalEndpointId);
        assert.equal(originalSurface.reconnectAttempt, 0);
        assert.equal(originalSurface.unreachableFailures, 0);

        await waitFor(() => replacementServer.pairedSocket !== null, 3_000);
        await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 3_000);
      } finally {
        await replacementServer.close();
      }
    });
  });

  await t.test("fingerprint identity does not rebind live paired surface on endpoint alias churn", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const replacementPort = nextPort++;
      const replacementServer = new FakeSurfAceWsServer(replacementPort);

      try {
        const internalRuntime = runtime as any;
        const originalSurface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(originalSurface);
        assert.ok(originalSurface.client?.isOpen());
        const originalEndpointId = originalSurface.endpointId;

        internalRuntime.refreshEndpointTopology({
          ...discoveryEndpoint(replacementPort, originalSurface.fingerprintPrefix),
          endpointId: `endpoint-${replacementPort}`,
        });

        assert.equal(internalRuntime.surfaces.get(server.surfaceId), originalSurface);
        assert.equal(originalSurface.endpointId, originalEndpointId);
        assert.equal(originalSurface.client?.isOpen(), true);
      } finally {
        await replacementServer.close();
      }
    });
  });

  await t.test("connect-failure refresh does not rebind by ambiguous fingerprint prefix", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const originalEndpointId = surface.endpointId;
      const sharedFingerprint = surface.fingerprintPrefix;
      assert.ok(sharedFingerprint);

      discovery.setEndpoints([
        discoveryEndpoint(nextPort++, sharedFingerprint),
        discoveryEndpoint(nextPort++, sharedFingerprint),
      ]);

      await internalRuntime.refreshEndpointAfterConnectFailure(surface, new Error("ECONNREFUSED"));

      assert.equal(surface.endpointId, originalEndpointId);
        assert.ok(
          warnings.some((warning) =>
            warning.includes("not refreshing stale endpoint") &&
            warning.includes("matched 2 endpoints")),
        );
    });
  });

  await t.test("discovery does not reuse a stopped surface id when the endpoint reappears", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const originalSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(originalSurface);

      originalSurface.stopRequested = true;
      internalRuntime.refreshEndpointTopology(structuredClone(originalSurface.endpoint));

      assert.equal(internalRuntime.surfaces.has(server.surfaceId), false);
      const replacementProbe = internalRuntime.endpointProbes.get(originalSurface.endpointId);
      assert.ok(replacementProbe);
      assert.notEqual(replacementProbe, originalSurface);
      assert.equal(replacementProbe.stopRequested, false);
      assert.equal("surfaceId" in replacementProbe, false);
      assert.equal("panes" in replacementProbe, false);
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
        frame: { height: 768, width: 1024, x: 0, y: 0 },
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
      const restartEntry = {
        contentId: "ct_restart_remap",
        contentType: "markdown",
        contentValue: "# restart remap",
        historyOwnerToken: "hot_restart_remap",
        paneLabel: bootstrapPane.paneLabel,
        revision: 17,
        sessionKey: "agent:test:restart-remap",
      };

      const remappingSurface = {
        ...preservedSurface,
        client: {
          close: async () => {},
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
        surfaceId: "sf_reconnect_previous" as any,
        workPromise: null,
      };

      internalRuntime.surfaces.set(remappingSurface.surfaceId, remappingSurface);
      internalRuntime.restartContentBySurface = new Map([
        [remappingSurface.surfaceId, [restartEntry]],
      ]);
      internalRuntime.restartSnapshots = new Map([
        [remappingSurface.surfaceId, { snapshot: "restart-snapshot" }],
      ]);
      const discoveredSurfaces = await internalRuntime.discoverSurfaceId(remappingSurface);
      assert.deepEqual(discoveredSurfaces.map((surface: any) => surface.surfaceId), [server.surfaceId]);

      const screen = (await runtime.listScreens()).find((entry) => entry.fingerprint === server.surfaceId);
      assert.ok(screen);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1, 2, 3]);
      assert.equal(internalRuntime.surfaces.get(server.surfaceId), preservedSurface);
      assert.equal(internalRuntime.surfaces.has("sf_reconnect_previous"), false);
      assert.equal(remappingSurface.stopRequested, true);
      await waitFor(() => remappingSurface.client === null);
      assert.equal(remappingSurface.client, null);
      assert.equal(preservedSurface.hasPairedInGatewaySession, true);
      assert.equal(preservedSurface.sessionId, "sa_test_session");
      assert.equal(internalRuntime.restartContentBySurface.has("sf_reconnect_previous"), false);
      assert.deepEqual(internalRuntime.restartContentBySurface.get(server.surfaceId), [restartEntry]);
      assert.equal(internalRuntime.restartSnapshots.has("sf_reconnect_previous"), false);
      assert.deepEqual(internalRuntime.restartSnapshots.get(server.surfaceId), {
        fingerprint: server.surfaceId,
        snapshot: "restart-snapshot",
      });
    });
  });

  await t.test("pair.response canonicalization preserves an existing canonical surface on remap", async () => {
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
      const canonicalClient = canonicalSurface.client;

      const bootstrapPane = structuredClone(canonicalSurface.panes.get(firstPaneId));
      assert.ok(bootstrapPane);

      const remappingSurface = {
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
        surfaceId: "sf_duplicate_hostname_previous" as any,
        workPromise: null,
      };

      internalRuntime.surfaces.set(remappingSurface.surfaceId, remappingSurface);
      const provisionalClient = remappingSurface.client;
      const adoptedSurface = internalRuntime.adoptCanonicalSurfaceId(remappingSurface, server.surfaceId, "pair.response");

      assert.equal(internalRuntime.surfaces.has("sf_duplicate_hostname_previous"), false);
      assert.equal(internalRuntime.surfaces.get(server.surfaceId), canonicalSurface);
      assert.equal(adoptedSurface, canonicalSurface);
      const screens = await runtime.listScreens();
      assert.equal(screens.filter((entry) => entry.fingerprint === server.surfaceId).length, 1);
      const screen = screens.find((entry) => entry.fingerprint === server.surfaceId);
      assert.ok(screen);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1, 2, 3]);
      assert.equal(canonicalSurface.hasPairedInGatewaySession, true);
      assert.equal(canonicalSurface.sessionId, "sa_test_session");
      assert.equal(canonicalSurface.client, canonicalClient);
      assert.notEqual(canonicalSurface.client, provisionalClient);
      assert.notEqual(canonicalSurface.client, null);
      assert.equal(remappingSurface.stopRequested, true);
      assert.equal(remappingSurface.client, null);
    });
  });

  await t.test("provisional entries accidentally placed in the canonical registry trip the pre-exposure invariant", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const canonicalSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(canonicalSurface);

      const leakedProbe = {
        ...canonicalSurface,
        client: null,
        connectedAt: null,
        connectionState: "connecting",
        endpoint: {
          ...canonicalSurface.endpoint,
          endpointId: "endpoint-leaked-probe",
          fingerprintPrefix: "",
        },
        endpointId: "endpoint-leaked-probe",
        fingerprintPrefix: "",
        hasPairedInGatewaySession: false,
        panes: new Map(),
        recentEventIds: [],
        recentEventIdsSet: new Set(),
        retryDelayResolver: null,
        sessionId: null,
        stopRequested: false,
        surfaceId: "sf_disc_leaked_probe" as any,
        workPromise: null,
        windowLabel: "",
      };
      internalRuntime.surfaces.set(leakedProbe.surfaceId, leakedProbe);

      await assert.rejects(runtime.listScreens(), /canonical surface registry invariant failed/);
      assert.equal(internalRuntime.surfaces.get(leakedProbe.surfaceId), leakedProbe);
      assert.ok(
        warnings.some((warning) =>
          warning.includes("canonical_surface_invariant_failed") &&
          warning.includes("sf_disc_leaked_probe")),
      );
    });
  });

  await t.test("discovery reconciles canonical endpoint surfaces through the remote registry", async () => {
    await withRuntimeHarness(async ({ discovery, infos, runtime, server }) => {
      const internalRuntime = runtime as any;
      const retainedSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(retainedSurface);
      assert.ok(retainedSurface.client?.isOpen());
      server.addSurface({ initialRemotePaneId: 42, name: "Legitimate Sibling", surfaceId: "sf_legitimate_sibling" });

      const siblingSurface = {
        ...retainedSurface,
        autoRetryEnabled: true,
        client: null,
        connectedAt: null,
        connectionState: "connecting",
        hasPairedInGatewaySession: false,
        lastSeenAt: retainedSurface.lastSeenAt - 500,
        panes: new Map(),
        recentEventIds: [],
        recentEventIdsSet: new Set(),
        retryDelayResolver: null,
        sessionId: null,
        stopRequested: false,
        surfaceId: "sf_legitimate_sibling" as any,
        workPromise: null,
        windowLabel: "y",
      };
      const staleSurface = {
        ...retainedSurface,
        autoRetryEnabled: true,
        client: null,
        connectedAt: null,
        connectionState: "connecting",
        hasPairedInGatewaySession: false,
        lastSeenAt: retainedSurface.lastSeenAt - 1_000,
        panes: new Map(),
        recentEventIds: [],
        recentEventIdsSet: new Set(),
        retryDelayResolver: null,
        sessionId: null,
        stopRequested: false,
        surfaceId: "sf_disc_stale_same_endpoint" as any,
        workPromise: null,
        windowLabel: "z",
      };
      internalRuntime.surfaces.set(siblingSurface.surfaceId, siblingSurface);
      internalRuntime.surfaces.set(staleSurface.surfaceId, staleSurface);

      await discovery.refreshNow();
      await waitFor(() => !internalRuntime.surfaces.has(staleSurface.surfaceId));

      assert.equal(internalRuntime.surfaces.get(server.surfaceId), retainedSurface);
      assert.equal(internalRuntime.surfaces.get(siblingSurface.surfaceId), siblingSurface);
      assert.equal(siblingSurface.stopRequested, false);
      assert.equal(internalRuntime.surfaces.has(staleSurface.surfaceId), false);
      assert.equal(staleSurface.stopRequested, true);
      assert.equal(server.pairRequestSurfaceIds.includes(staleSurface.surfaceId), false);
      assert.ok(
        infos.some((info) =>
          info.includes("surface_removed") &&
          info.includes("surfaces_list_absent") &&
          info.includes(staleSurface.surfaceId)),
      );
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

  await t.test("polluted persisted remote pane labels are compacted instead of displayed", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, {
      initialPaneLabel: 4,
      initialRemotePaneId: 6243,
      surfaceId: "sf_surface-a",
    });
    server.panes.set(6245, {
      contentId: null,
      contentType: null,
      drawings: [],
      frame: { height: 768, width: 1024, x: 0, y: 0 },
      name: null,
      paneLabel: 5,
      revision: 0,
      viewport: {
        height: 768,
        scale: 2,
        width: 1024,
      },
    });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-pane-label-polluted-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 6244,
            nextRemotePaneId: 6246,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {
              [`${server.surfaceId}::6243`]: 4,
              [`${server.surfaceId}::6245`]: 5,
            },
            providerId: "pv_test_provider",
            version: 1,
            windowLabels: {
              [server.surfaceId]: "a",
            },
          },
          null,
          2,
        ),
      );

      await runtime.start();
      await waitFor(() => server.pairedSocket !== null);

      const screen = (await runtime.listScreens())[0];
      assert.ok(screen);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1, 2]);
      assert.equal(server.pairRequests[0]?.initialPaneLabel, 1);

      const split = await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: screen.panes[0]!.paneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);
      assert.deepEqual(server.topologyApplyRequests.at(-1)?.paneLabels, [1, 3, 2]);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("provider restart resumes still-running surface with persisted ownership identity", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_restart_owner" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-restart-owner-"));
    const providerId = "pv_restart_owner";
    const sessionId = "sa_restart_session";
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });
    server.lockedProviderId = providerId;
    server.lockedSessionId = sessionId;

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            version: 1,
            windowLabels: {
              [server.surfaceId]: "a",
            },
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            screens: [
              {
                _debug: {
                  autoRetryEnabled: true,
                  endpointId: "endpoint-before-provider-restart",
                  hasPairedInGatewaySession: true,
                  reconnectAttempt: 0,
                  sessionId,
                  unreachableFailures: 0,
                  wsOpen: true,
                },
                connectionState: "connected",
                fingerprint: server.surfaceId,
                lastSeenAt: Date.now(),
                name: "Restart Owner",
                panes: [],
                pendingEvents: 0,
                viewport: {
                  height: 768,
                  scale: 2,
                  width: 1024,
                },
                windowLabel: "a",
              },
            ],
            updatedAt: Date.now() - 10 * 60_000,
            version: 1,
          },
          null,
          2,
        ),
      );

      await runtime.start();
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(server.pairAttemptDetails.length, 1);
      assert.equal(server.pairAttemptDetails[0]?.providerId, providerId);
      assert.equal(server.pairAttemptDetails[0]?.resumeSessionId, sessionId);
      assert.equal(server.pairAttemptDetails[0]?.takeover, false);
      assert.equal(server.pairedSocket !== null, true);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("provider restart keeps persisted ownership through transient busy", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_restart_busy" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-restart-busy-"));
    const providerId = "pv_restart_busy";
    const sessionId = "sa_restart_busy_session";
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });
    server.lockedProviderId = providerId;
    server.lockedSessionId = sessionId;
    server.busyWithoutTakeoverResponsesRemaining = 1;

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            version: 1,
            windowLabels: {
              [server.surfaceId]: "a",
            },
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            screens: [
              {
                _debug: {
                  autoRetryEnabled: true,
                  endpointId: "endpoint-before-provider-restart",
                  hasPairedInGatewaySession: true,
                  reconnectAttempt: 0,
                  sessionId,
                  unreachableFailures: 0,
                  wsOpen: true,
                },
                connectionState: "connected",
                fingerprint: server.surfaceId,
                lastSeenAt: Date.now(),
                name: "Restart Busy",
                panes: [],
                pendingEvents: 0,
                viewport: {
                  height: 768,
                  scale: 2,
                  width: 1024,
                },
                windowLabel: "a",
              },
            ],
            updatedAt: Date.now(),
            version: 1,
          },
          null,
          2,
        ),
      );

      await runtime.start();
      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(server.pairAttemptDetails[0]?.providerId, providerId);
      assert.equal(server.pairAttemptDetails[0]?.resumeSessionId, sessionId);
      assert.equal(server.pairAttemptDetails[0]?.takeover, false);
      assert.equal(server.pairAttemptDetails[1]?.providerId, providerId);
      assert.equal(server.pairAttemptDetails[1]?.resumeSessionId, null);
      assert.equal(server.pairAttemptDetails[1]?.takeover, true);
    } finally {
      await runtime.stop();
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

      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);

      assert.equal(server.pairAttemptDetails[1]?.resumeSessionId, "sa_test_session");
      assert.equal(server.pairAttemptDetails[1]?.takeover, false);
      assert.equal(surface.sessionId, "sa_test_session");
      assert.equal(surface.hasPairedInGatewaySession, true);
    });
  });

  await t.test("busy on nil-session cold-start surface with persisted capability state does not self-reclaim", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;

      const providerId = server.pairAttemptDetails[0]?.providerId;

      server.busyWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_cold_start_busy_no_self_reclaim");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(server.pairAttemptDetails[1]?.takeover, false);
      assert.equal(server.pairAttemptDetails[2]?.takeover, false);
      assert.equal(server.pairAttemptDetails[2]?.providerId, providerId);
      assert.ok(
        warnings.some((warning) => warning.includes("ownership_self_reclaim_blocked") && warning.includes(server.surfaceId)),
      );
    });
  });

  await t.test("busy after a live-session drop self-reclaims with stable provider identity", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      assert.equal(surface.hasPairedInGatewaySession, true);
      const providerId = server.pairAttemptDetails[0]?.providerId;

      // Return busy once, then self-reclaim with the same provider identity.
      server.busyWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_live_session_busy_self_reclaim");

      // Wait for reconnect: first attempt gets busy, second succeeds as self-reclaim.
      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(server.pairAttemptDetails[1]?.takeover, false);
      assert.equal(server.pairAttemptDetails[2]?.takeover, true);
      assert.equal(server.pairAttemptDetails[2]?.providerId, providerId);
      assert.ok(
        warnings.some((warning) => warning.includes("ownership_self_reclaim") && warning.includes(server.surfaceId)),
      );
    });
  });

  await t.test("foreign-provider busy on a known surface does not self-reclaim with takeover", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      assert.equal(surface.hasPairedInGatewaySession, true);

      server.busyWithoutTakeoverResponsesRemaining = 1;
      server.busyWithoutTakeoverMessage = "Surface ownership lock is held by another provider";
      await surface.client.close(1000, "test_foreign_busy_no_self_reclaim");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 3).map((attempt) => attempt.takeover),
        [false, false],
      );
      assert.ok(
        warnings.some((warning) => warning.includes("backing off") && warning.includes("takeover requires explicit user action")),
      );
    });
  });

  await t.test("busy on an unknown surface remains explicit operator reclaim", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_foreign_busy" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-foreign-busy-"));
    const warnings: string[] = [];
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({
      discovery,
      logger: {
        error: () => {},
        info: () => {},
        warn: (message: string) => warnings.push(message),
      },
      stateDir,
    });
    server.busyWithoutTakeoverResponsesRemaining = 1;

    try {
      await runtime.start();
      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(0, 2).map((attempt) => attempt.takeover),
        [false, false],
      );
      assert.ok(
        warnings.some((warning) => warning.includes("backing off") && warning.includes("takeover requires explicit user action")),
      );
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
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

  await t.test("busy with persisted target state but no resume session does not self-reclaim", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      internalRuntime.persistentState.targetStateBySurfaceId = {
        [server.surfaceId]: {
          paneTargets: {},
          registeredTargetIdsByIdempotencyKey: {},
          targetRecords: [],
        },
      };

      server.busyWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_persisted_target_state_no_takeover");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 3).map((attempt) => attempt.takeover),
        [false, false],
      );
      assert.ok(
        warnings.some((warning) =>
          warning.includes("ownership_self_reclaim_blocked") &&
          warning.includes("had_persisted_target_state=true")),
      );
    });
  });

  await t.test("stale content during resumed replay is skipped without provider shutdown loop", async () => {
    await withRuntimeHarness(async ({ infos, runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.push({
        content: "<p>before reconnect</p>",
        contentType: "html",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      surface.topologyRevision = 1;

      server.nextContentApplyError = {
        code: "stale_content",
        message: "content.apply targeted stale content",
      };
      await surface.client.close(1000, "test_stale_replay_skip");

      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.ok(
        infos.some((info) =>
          info.includes("event=resume_replay_outcome") &&
          info.includes("outcome=skipped_stale") &&
          info.includes("error_code=stale_content")),
      );
    });
  });

  await t.test("topology apply diagnostics include payload and before/after pane sets", async () => {
    await withRuntimeHarness(async ({ infos, runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      assert.ok(
        infos.some((info) =>
          info.includes("event=topology_apply_begin") &&
          info.includes("payload=") &&
          info.includes("before_pane_ids=") &&
          info.includes("expected_topology_revision=")),
      );
      assert.ok(
        infos.some((info) =>
          info.includes("event=topology_apply_ok") &&
          info.includes("after_pane_ids=") &&
          info.includes("created_pane_ids=") &&
          info.includes("response_panes=")),
      );
      assert.equal(server.topologyApplyRequests.length, 1);
    });
  });

});
