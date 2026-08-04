import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ControllerStateStore,
  ControllerWire,
  ControllerWireEnvelope,
} from "@surf-ace/controller";
import { SURF_ACE_LOCKLESS_V1_CAPABILITY } from "@surf-ace/protocol";

import type {
  SurfAceDiscoveryEndpoint,
  SurfAceDiscoveryService,
} from "./surf-ace-discovery.js";
import {
  advertisesLocklessCapability,
  OpenClawLocklessController,
} from "./openclaw-lockless-controller.js";
import {
  DefaultSurfAceRuntime,
  type PaneId,
} from "./surf-ace-runtime.js";
import { surfAceToolNames } from "./surf-ace-tools.js";

class MemoryStore implements ControllerStateStore {
  value: unknown = null;

  async load(): Promise<unknown | null> {
    return structuredClone(this.value);
  }

  async save(value: unknown): Promise<void> {
    this.value = structuredClone(value);
  }
}

class StaticDiscovery implements SurfAceDiscoveryService {
  private listener: ((endpoints: SurfAceDiscoveryEndpoint[]) => void) | null =
    null;

  constructor(private readonly endpoint: SurfAceDiscoveryEndpoint) {}

  getSnapshot(): SurfAceDiscoveryEndpoint[] {
    return [this.endpoint];
  }

  async refreshNow() {}

  async start() {
    this.listener?.([this.endpoint]);
  }

  async stop() {}

  subscribe(
    listener: (endpoints: SurfAceDiscoveryEndpoint[]) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
}

class LocklessFakeWire implements ControllerWire {
  closeCount = 0;
  readonly requests: Array<{ op: string; payload: unknown }> = [];
  private eventListener:
    ((event: ControllerWireEnvelope) => void) | null = null;
  private paired = false;

  constructor(
    private readonly surfaceConnection = false,
    private readonly endpointState: {
      displayId?: string;
      live: boolean;
      paneAddress?: string;
      paneId?: number;
      paneLabel?: number;
      paneLive?: boolean;
      staleTopologyOnce?: boolean;
      topologyRevision?: number;
    } = { live: true },
  ) {}

  async close() {
    this.closeCount += 1;
  }

  async connect() {}

  onEvent(listener: (event: ControllerWireEnvelope) => void): () => void {
    this.eventListener = listener;
    return () => {
      this.eventListener = null;
    };
  }

  emit(event: ControllerWireEnvelope): void {
    this.eventListener?.(event);
  }

  async request(
    op: string,
    payload: unknown = {},
    id?: string,
  ): Promise<ControllerWireEnvelope> {
    this.requests.push({ op, payload });
    if (op === "surfaces.list" && !this.paired) {
      return response(op, {
        capabilities: {
          protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
        },
        surfaces: [],
      }, id);
    }
    if (op === "pair.request") {
      this.paired = true;
      const request = payload as { controllerInstanceId: string };
      const paneId = this.endpointState.paneId ?? 1;
      const pairPayload = payload as {
        controllerInstanceId: string;
        migrationMaterial?: unknown;
      };
      return response(op, {
        capabilities: {},
        controllerInstanceId: request.controllerInstanceId,
        limits: {},
        migrationAccepted: Boolean(pairPayload.migrationMaterial),
        migrationReceiptId: pairPayload.migrationMaterial ? id : null,
        mode: "lockless",
        receiptResolutions: [],
        resumed: false,
        scopes: this.surfaceConnection
          ? [{
              cursor: { cursor: 1, gap: null, gapGeneration: 0 },
              firstRetainedSequence: 1,
              lastRetainedSequence: 10,
              records: consumableRecords(),
              scopeId: `pane:sf_1:${paneId}`,
              version: 1,
            }]
          : [],
        sessionId: `lockless_${request.controllerInstanceId}`,
        state: null,
        surfaceId: this.surfaceConnection ? "sf_1" : null,
        surfaceSetRevision: 1,
      }, id);
    }
    if (op === "surfaces.list") {
      return response(op, {
        surfaces: this.endpointState.live ? [{
          name: "Studio",
          surfaceId: "sf_1",
          viewport: { height: 768, scale: 1, width: 1024 },
          windowLabel: "Surf Ace 1",
        }] : [],
      });
    }
    if (op === "panes.list") {
      const paneId = this.endpointState.paneId ?? 1;
      return response(op, {
        panes: this.endpointState.paneLive === false ? [] : [{
          activeContentId: "ct_1",
          contentType: "html",
          currentTarget: {
            targetEpoch: 1,
            targetHeader: { payloadSchemaVersion: 1 },
            targetId: "tg_1",
            targetKind: "native_app",
            targetPayload: { appId: "com.example.App" },
          },
          currentRevision: 3,
          displayId: this.endpointState.displayId,
          paneAddress: this.endpointState.paneAddress,
          paneId,
          paneLabel: this.endpointState.paneLabel ?? paneId,
          paneLineageId: "pl_1",
          viewport: { height: 768, scale: 1, width: 1024 },
        }],
        topology: {
          layout: { paneId: 1, type: "pane" },
          topologyRevision: this.endpointState.topologyRevision ?? 4,
        },
      });
    }
    if (op === "content.clear") {
      return response(op, { currentRevision: 4 });
    }
    if (op === "content.set") {
      return response(op, {
        contentId: (payload as { contentId?: string }).contentId,
        historyEntryId: "he_1",
        paneId: 1,
        revision: 4,
      }, id);
    }
    if (op === "pane.rename" || op === "pane.restore") {
      return response(op, {
        paneId: this.endpointState.paneId ?? 1,
        topologyRevision: 5,
      }, id);
    }
    if (op === "pane.close") {
      this.endpointState.paneLive = false;
      return response(op, {
        paneId: this.endpointState.paneId ?? 1,
        topologyRevision: 5,
      }, id);
    }
    if (op === "topology.apply") {
      if (this.endpointState.staleTopologyOnce) {
        this.endpointState.staleTopologyOnce = false;
        this.endpointState.topologyRevision = 9;
        return {
          error: {
            code: "stale_topology",
            message: "Expected topology revision 9",
          },
          id,
          ok: false,
          op,
          payload: {
            currentTopology: { paneId: 1, type: "pane" },
            currentTopologyRevision: 9,
          },
          type: "response",
        };
      }
      return response(op, {
        createdPaneIds: [],
        destroyedPaneIds: [2],
        destroyedPaneTombstones: [{
          closedSequence: 9,
          paneId: 2,
          tombstoneId: "pt_2",
        }],
        panes: [{
          activeContentId: "ct_1",
          contentType: "html",
          paneId: 1,
          paneLabel: 1,
        }],
        preservedPaneIds: [1],
        topology: { paneId: 1, type: "pane" },
        topologyRevision: 5,
      }, id);
    }
    if (op === "target.register") {
      return response(op, {
        idempotencyKey:
          (payload as { idempotencyKey?: string }).idempotencyKey,
        registered: true,
        target: {
          targetEpoch: 2,
          targetId: "tg_registered",
        },
      }, id);
    }
    if (op === "target.apply") {
      return response(op, {
        applied: true,
        blockedReason: null,
        requestId: (payload as { requestId?: string }).requestId,
        targetEpoch: (payload as { targetEpoch?: number }).targetEpoch,
        targetId: (payload as { targetId?: string }).targetId,
      }, id);
    }
    if (op === "consumable.ack") {
      return response(op, {
        acceptedCursor: Number((payload as { cursor?: number }).cursor),
      }, id);
    }
    if (op === "annotations.remove") {
      return response(op, {
        notFoundStrokeIds: [],
        remainingStrokeCount: 0,
        removedStrokeIds: ["st_1"],
      });
    }
    if (op === "snapshot.get") {
      return response(op, {
        contentId: "ct_1",
        contentType: "html",
        image: "aW1hZ2U=",
        revision: 3,
        selection: { anchorEnd: null, anchorStart: null, selectedText: "" },
        viewport: {
          contentSize: { height: 768, width: 1024 },
          visibleRect: { height: 768, width: 1024, x: 0, y: 0 },
        },
      });
    }
    if (op === "surface.window.close") {
      this.endpointState.live = false;
      return response(op, {
        surfaceId: "sf_1",
        tombstoneId: "ts_1",
      });
    }
    if (op === "surface.window.restore") {
      this.endpointState.live = true;
      return response(op, { surfaceId: "sf_1" });
    }
    throw new Error(`unexpected operation ${op}`);
  }
}

function consumableRecords() {
  const payloads = [
    ["annotation_frame", {
      contentId: "ct_1",
      firstStrokeAt: 10,
      flushId: "fr_1",
      lastStrokeAt: 11,
      strokes: [{
        points: [{ timestamp: 10, x: 2, y: 3 }],
        strokeId: "st_1",
      }],
    }],
    ["tap", { kind: "tap", nearestContent: "Button", position: { x: 4, y: 5 } }],
    ["content", { contentId: "ct_1", revision: 3 }],
    ["history", { direction: "back" }],
    ["topology", { topologyRevision: 4 }],
    ["scroll", {
      viewport: {
        visibleRect: { height: 100, width: 200, x: 6, y: 7 },
      },
    }],
    ["selection", {
      selection: { anchorEnd: 4, anchorStart: 1, selectedText: "text" },
    }],
    ["page", { page: 2, pageText: "2", totalPages: 5 }],
    ["playback", { playbackPosition: 12, playbackState: "playing" }],
    ["navigation", { navigatedAt: 20, url: "https://example.test" }],
  ] as const;
  return payloads.map(([recordClass, payload], index) => ({
    bytes: 10,
    payload,
    recordClass,
    recordId: `cr_${index + 1}`,
    sequence: index + 1,
  }));
}

function response(
  op: string,
  payload: unknown,
  id = `rq_${op}`,
): ControllerWireEnvelope {
  return { id, ok: true, op, payload, type: "response" };
}

test("lockless mode requires the exact pre-pair advertised capability", () => {
  assert.equal(advertisesLocklessCapability({
    capabilities: {
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
    },
  }), true);
  assert.equal(advertisesLocklessCapability({
    capabilities: { protocolFeatures: ["authority.state.v1"] },
  }), false);
  assert.equal(advertisesLocklessCapability({ surfaces: [] }), false);
});

test("only a genuinely non-capable endpoint enters the unchanged legacy route", async () => {
  const endpoint: SurfAceDiscoveryEndpoint = {
    busy: false,
    capabilitiesBitmask: 0,
    endpointId: "electron-legacy",
    fingerprintPrefix: "legacy",
    host: "127.0.0.1",
    instanceName: "Surf Ace",
    lastSeenAt: 1,
    name: "Legacy",
    port: 17_700,
    protocolVersion: 1,
    viewport: { height: 1, scale: 1, width: 1 },
    wsPath: "/ws",
  };
  const wireForFeatures = (protocolFeatures: string[]): ControllerWire => ({
    async close() {},
    async connect() {},
    onEvent() {
      return () => {};
    },
    async request(op, _payload, id) {
      if (op === "surfaces.list") {
        return response(op, { capabilities: { protocolFeatures } }, id);
      }
      return {
        error: { code: "migration_rejected", message: "rejected" },
        id,
        ok: false,
        op,
        payload: {},
        type: "response",
      };
    },
  });
  const legacy = new OpenClawLocklessController({
    discovery: new StaticDiscovery(endpoint),
    stateDir: "/unused",
    storeFactory: () => new MemoryStore(),
    wireFactory: () => wireForFeatures([]),
  });
  await legacy.start();
  assert.deepEqual(
    legacy.legacyDiscovery().getSnapshot().map((value) => value.endpointId),
    ["electron-legacy"],
  );
  await legacy.stop();

  const capableButRejected = new OpenClawLocklessController({
    discovery: new StaticDiscovery(endpoint),
    stateDir: "/unused",
    storeFactory: () => new MemoryStore(),
    wireFactory: () =>
      wireForFeatures([SURF_ACE_LOCKLESS_V1_CAPABILITY]),
  });
  await capableButRejected.start();
  assert.deepEqual(
    capableButRejected.legacyDiscovery().getSnapshot(),
    [],
    "lockless admission failure must not fall back to legacy",
  );
  await capableButRejected.stop();
});

test("OpenClaw manifest exposes every registered official Surf Ace tool", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { contracts: { tools: string[] }; tools: string[] };
  assert.deepEqual(manifest.tools, [...surfAceToolNames]);
  assert.deepEqual(manifest.contracts.tools, [...surfAceToolNames]);
});

test("lockless alert presentation has no embedded host or session route", async () => {
  const source = await readFile(
    new URL("./openclaw-lockless-controller.ts", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("localhost:18800"), false);
  assert.equal(source.includes("agent:main:main"), false);
});

test("legacy migration uses remote pane identity, preserves unknown tap loss, and waits for snapshot sync", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "surf-ace-migration-"));
  const runtime = new DefaultSurfAceRuntime({ stateDir });
  const buffer = {
    closedFrames: [],
    currentUrl: null,
    lastNavigation: null,
    liveDirtyStrokeIds: [],
    liveFrame: null,
    liveSeq: 0,
    overflowed: true,
    page: null,
    playbackPosition: null,
    playbackState: null,
    scrollPosition: null,
    selection: null,
    taps: [{
      eventId: "ev_legacy",
      kind: "tap",
      nearestText: "Button",
      timestamp: 10,
      x: 2,
      y: 3,
    }],
  };
  const surface = {
    endpointId: "electron-1",
    panes: new Map([[
      "local-pane-7",
      {
        buffer,
        paneId: "local-pane-7",
        remotePaneId: 41,
      },
    ]]),
    snapshotBufferedEvents: [],
    snapshotBufferOverflowGeneration: 1,
    snapshotBufferOverflowed: true,
    snapshotSyncInFlight: true,
    surfaceId: "sf_1",
  };
  (runtime as any).surfaces.set("sf_1", surface);

  assert.equal(
    await runtime.exportLegacyLocklessMigration(
      "electron-1",
      "sf_1",
      "ci_migration" as never,
    ),
    null,
    "provider-local snapshot events are never skipped during admission",
  );
  assert.equal(buffer.taps.length, 1);
  assert.equal(buffer.overflowed, true);

  surface.snapshotSyncInFlight = false;
  const prepared = await runtime.exportLegacyLocklessMigration(
    "electron-1",
    "sf_1",
    "ci_migration" as never,
  );
  assert.ok(prepared);
  const paneScope = prepared.material.scopes.find((scope) =>
    scope.scopeKind === "pane"
  );
  assert.equal(paneScope?.scopeId, "pane:sf_1:41");
  assert.notEqual(paneScope?.scopeId, "pane:sf_1:local-pane-7");
  assert.deepEqual(prepared.material.gaps?.find((gap) =>
    gap.scopeId === "pane:sf_1:41"
  ), {
    gap: {
      cause: "legacy_overflow",
      droppedBytes: null,
      droppedEventCount: null,
      droppedFrameCount: null,
      droppedRecordCount: null,
      firstLostSequence: null,
      lastLostSequence: null,
      lossExtent: "unknown",
      recordClasses: ["tap"],
    },
    scopeId: "pane:sf_1:41",
  });
  assert.equal(
    prepared.material.gaps?.find((gap) =>
      gap.scopeId === "surface:sf_1"
    )?.gap.lossExtent,
    "unknown",
  );
  assert.equal(buffer.taps.length, 1, "export is non-destructive");
  assert.equal(buffer.overflowed, true);

  await prepared.markPairSent();
  await prepared.markClientCommitted(prepared.pairRequestId);
  await prepared.markSourceCleared();
  await prepared.complete();
  assert.deepEqual(buffer.taps, []);
  assert.equal(buffer.overflowed, false);
  assert.equal(surface.snapshotBufferOverflowed, false);
  await rm(stateDir, { force: true, recursive: true });
});

test("Gate 2A copied runtime continuity replays prepared state unchanged across live rehydration and every durable cutover boundary", async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "surf-ace-gate2a-"));
  const stateDir = path.join(testRoot, "source");
  const runtime = new DefaultSurfAceRuntime({ stateDir });
  const closedFrame = {
    contentId: "ct_closed",
    contextKey: "ctx",
    frameId: "fr_closed",
    image: "aW1hZ2U=",
    openedAt: 1,
    scrollOffset: { x: 0, y: 0 },
    strokes: [{
      bbox: { height: 1, width: 1, x: 1, y: 1 },
      endedAt: 2,
      points: [{ pressure: 0.5, x: 1, y: 1 }],
      startedAt: 1,
      strokeId: "st_closed",
    }],
    updatedAt: 2,
    viewport: { height: 100, scale: 1, width: 100 },
  };
  const liveFrame = {
    ...closedFrame,
    frameId: "fr_live",
    strokes: [{ ...closedFrame.strokes[0], strokeId: "st_dirty" }],
  };
  const buffer = {
    closedFrames: [closedFrame],
    currentUrl: "https://example.test/current",
    lastNavigation: { navigatedAt: 12, url: "https://example.test/next" },
    liveDirtyStrokeIds: ["st_dirty"],
    liveFrame,
    liveSeq: 7,
    overflowed: true,
    page: { pageCount: 8, pageLabel: "iii", pageNumber: 3 },
    playbackPosition: 14,
    playbackState: "playing",
    scrollPosition: {
      visibleRect: { height: 10, width: 20, x: 4, y: 5 },
      x: 4,
      y: 5,
    },
    selection: {
      anchorEnd: 5,
      anchorStart: 1,
      selectedText: "text",
    },
    taps: [{
      eventId: "ev_original",
      kind: "tap",
      nearestText: "Button",
      timestamp: 10,
      x: 2,
      y: 3,
    }],
  };
  const pane = {
    activeContentId: "ct_visible",
    buffer,
    contentType: "html",
    contentValue: { html: "<p>visible</p>" },
    currentRevision: 9,
    display: { kind: "web" },
    historyEntries: [{
      contentId: "ct_history",
      contentType: "markdown",
      contentValue: { markdown: "old" },
      display: null,
      historyOwnerToken: null,
      revision: 8,
      sessionKey: "agent:chat",
      targetId: null,
    }],
    historySummary: {
      backCount: 1,
      forwardCount: 0,
      visibleContentId: "ct_visible",
      visibleProvenance: { displayName: "Chat", sessionKey: "agent:chat" },
    },
    name: "Main",
    ownerSessionKey: "agent:chat",
    paneId: "local-pane-7",
    paneLabel: 1,
    paneLineageId: "pl_1",
    remotePaneId: 41,
    viewport: { height: 100, scale: 1, width: 100 },
  };
  const surface = {
    endpointId: "electron-1",
    layout: { paneId: "local-pane-7", type: "pane" },
    panes: new Map([[pane.paneId, pane]]),
    snapshotBufferedEvents: [],
    snapshotBufferOverflowGeneration: 3,
    snapshotBufferOverflowed: true,
    snapshotSyncInFlight: false,
    surfaceId: "sf_1",
    topologyRevision: 4,
    viewport: { height: 100, scale: 1, width: 100 },
    windowLabel: "Studio",
  };
  (runtime as any).surfaces.set("sf_1", surface);

  const prepared = await runtime.exportLegacyLocklessMigration(
    "electron-1",
    "sf_1",
    "ci_gate2a" as never,
  );
  assert.ok(prepared);
  const paneScope = prepared.material.scopes.find((scope) =>
    scope.scopeKind === "pane"
  );
  assert.deepEqual(
    new Set(paneScope?.records.map((record) => record.recordClass)),
    new Set([
      "annotation_frame",
      "tap",
      "scroll",
      "selection",
      "page",
      "playback",
      "navigation",
      "content",
      "history",
    ]),
  );
  assert.deepEqual(
    (paneScope?.liveFrames?.[0]?.payload as { liveDirtyStrokeIds?: string[] })
      .liveDirtyStrokeIds,
    ["st_dirty"],
  );
  assert.equal(
    prepared.material.scopes.find((scope) => scope.scopeKind === "surface")
      ?.records[0]?.recordClass,
    "topology",
  );

  const statePath = path.join(stateDir, "surf-ace-runtime-state.json");
  const copyAtPhase = async (
    phase: string,
    liveSurface?: typeof surface,
  ) => {
    const copiedDir = path.join(testRoot, phase);
    await mkdir(copiedDir, { recursive: true });
    await copyFile(
      statePath,
      path.join(copiedDir, "surf-ace-runtime-state.json"),
    );
    const recovered = new DefaultSurfAceRuntime({ stateDir: copiedDir });
    await recovered.hydrateLegacyLocklessMigrationContinuity();
    if (liveSurface) {
      (recovered as any).surfaces.set(
        String(liveSurface.surfaceId),
        liveSurface,
      );
    }
    const handle = await recovered.exportLegacyLocklessMigration(
      "electron-1",
      "sf_1",
      "ci_gate2a" as never,
    );
    assert.ok(handle);
    assert.equal(handle.pairRequestId, prepared.pairRequestId);
    return { copiedDir, handle, recovered };
  };

  const preparedState = JSON.parse(await readFile(statePath, "utf8"));
  const preparedRecord = structuredClone(
    preparedState.locklessMigrationContinuity.endpoints["electron-1"]
      .surfaces.sf_1,
  );
  const rehydratedSurface = structuredClone(surface);
  const rehydratedPane = rehydratedSurface.panes.get("local-pane-7");
  assert.ok(rehydratedPane);
  rehydratedPane.buffer.taps.push({
    eventId: "ev_newer_after_prepared",
    kind: "tap",
    nearestText: "Newer",
    timestamp: 99,
    x: 9,
    y: 9,
  });
  const replayedPrepared = await copyAtPhase(
    "prepared-live-newer",
    rehydratedSurface,
  );
  const replayedPreparedState = JSON.parse(await readFile(
    path.join(
      replayedPrepared.copiedDir,
      "surf-ace-runtime-state.json",
    ),
    "utf8",
  ));
  const replayedPreparedRecord =
    replayedPreparedState.locklessMigrationContinuity.endpoints["electron-1"]
      .surfaces.sf_1;
  assert.deepEqual(
    replayedPreparedRecord.transaction,
    preparedRecord.transaction,
    "rehydrated live state must not change the prepared transaction identity or hashes",
  );
  assert.deepEqual(replayedPreparedRecord.material, preparedRecord.material);
  assert.deepEqual(replayedPreparedRecord.source, preparedRecord.source);
  assert.deepEqual(
    replayedPrepared.handle.material,
    prepared.material,
    "the exact prepared material remains recoverable for same-ID replay",
  );
  await replayedPrepared.handle.markPairSent();
  await replayedPrepared.handle.markClientCommitted(prepared.pairRequestId);
  await replayedPrepared.handle.markSourceCleared();
  assert.deepEqual(
    rehydratedPane.buffer.taps.map((tap) => tap.eventId),
    ["ev_newer_after_prepared"],
    "compare-by-digest clearing removes only the prepared prefix",
  );
  const clearedReplayedState = JSON.parse(await readFile(
    path.join(
      replayedPrepared.copiedDir,
      "surf-ace-runtime-state.json",
    ),
    "utf8",
  ));
  const clearedTransaction =
    clearedReplayedState.locklessMigrationContinuity.endpoints["electron-1"]
      .surfaces.sf_1.transaction;
  assert.equal(clearedTransaction.pairRequestId, preparedRecord.transaction.pairRequestId);
  assert.equal(clearedTransaction.sourceSha256, preparedRecord.transaction.sourceSha256);
  assert.equal(clearedTransaction.materialSha256, preparedRecord.transaction.materialSha256);

  let recovered = await copyAtPhase("prepared");
  const wrongIdentityRuntime = new DefaultSurfAceRuntime({
    stateDir: recovered.copiedDir,
  });
  await assert.rejects(
    wrongIdentityRuntime.exportLegacyLocklessMigration(
      "electron-1",
      "sf_1",
      "ci_wrong" as never,
    ),
    /lockless_migration_continuity_mismatch/,
  );
  await recovered.handle.markPairSent();
  await copyFile(
    path.join(recovered.copiedDir, "surf-ace-runtime-state.json"),
    statePath,
  );
  recovered = await copyAtPhase("pair-sent");
  await recovered.handle.markClientCommitted(prepared.pairRequestId);
  await copyFile(
    path.join(recovered.copiedDir, "surf-ace-runtime-state.json"),
    statePath,
  );
  recovered = await copyAtPhase("client-committed");
  await recovered.handle.markSourceCleared();
  await copyFile(
    path.join(recovered.copiedDir, "surf-ace-runtime-state.json"),
    statePath,
  );
  recovered = await copyAtPhase("source-cleared");
  await recovered.handle.complete();
  const completeState = JSON.parse(await readFile(
    path.join(recovered.copiedDir, "surf-ace-runtime-state.json"),
    "utf8",
  ));
  const transaction = completeState.locklessMigrationContinuity.endpoints[
    "electron-1"
  ].surfaces.sf_1.transaction;
  assert.equal(transaction.phase, "complete");
  assert.equal(transaction.pairRequestId, prepared.pairRequestId);
  assert.match(transaction.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(transaction.materialSha256, /^[0-9a-f]{64}$/);

  buffer.taps.push({
    eventId: "ev_concurrent",
    kind: "tap",
    timestamp: 99,
    x: 9,
    y: 9,
  });
  await prepared.markPairSent();
  await prepared.markClientCommitted(prepared.pairRequestId);
  await prepared.markSourceCleared();
  assert.deepEqual(buffer.taps.map((tap) => tap.eventId), ["ev_concurrent"]);

  const tamperedDir = path.join(testRoot, "tampered");
  await mkdir(tamperedDir, { recursive: true });
  const tampered = JSON.parse(await readFile(statePath, "utf8"));
  tampered.locklessMigrationContinuity.endpoints["electron-1"].surfaces.sf_1
    .material.scopes[0].records.push({ payload: {}, recordClass: "topology" });
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      path.join(tamperedDir, "surf-ace-runtime-state.json"),
      JSON.stringify(tampered),
    )
  );
  const tamperedRuntime = new DefaultSurfAceRuntime({ stateDir: tamperedDir });
  await assert.rejects(
    tamperedRuntime.exportLegacyLocklessMigration(
      "electron-1",
      "sf_1",
      "ci_gate2a" as never,
    ),
    /lockless_migration_continuity_mismatch/,
  );
  await rm(testRoot, { force: true, recursive: true });
});

test("OpenClaw consumes canonical lockless clear, annotation, and snapshot operations", async () => {
  const endpoint: SurfAceDiscoveryEndpoint = {
    busy: false,
    capabilitiesBitmask: 0,
    endpointId: "electron-1",
    fingerprintPrefix: "sf",
    host: "127.0.0.1",
    instanceName: "Surf Ace",
    lastSeenAt: 1,
    name: "Studio",
    port: 17_700,
    protocolVersion: 1,
    viewport: { height: 768, scale: 1, width: 1024 },
    wsPath: "/ws",
  };
  const stores = new Map<string, MemoryStore>();
  const wires: LocklessFakeWire[] = [];
  const endpointState = { live: true };
  const alerts: string[] = [];
  const controller = new OpenClawLocklessController({
    discovery: new StaticDiscovery(endpoint),
    stateDir: "/unused",
    storeFactory: (filePath) => {
      const existing = stores.get(filePath);
      if (existing) {
        return existing;
      }
      const created = new MemoryStore();
      stores.set(filePath, created);
      return created;
    },
    wireFactory: () => {
      const wire = new LocklessFakeWire(wires.length > 0, endpointState);
      wires.push(wire);
      return wire;
    },
    alertDelivery: async (message) => {
      alerts.push(message);
    },
  });
  await controller.start();
  try {
    assert.equal(wires.length, 2, "one lifecycle and one surface connection");
    assert.equal((await controller.listScreens())[0]?.fingerprint, "sf_1");

    const paneId = "1" as PaneId;
    const pushed = await controller.push({
      content: "# Official push",
      contentType: "markdown",
      fingerprint: "sf_1",
      paneId,
    });
    assert.equal(pushed.revision, 4);
    const contentSetRequest = wires
      .flatMap((wire) => wire.requests)
      .find((request) => request.op === "content.set");
    assert.deepEqual(
      (contentSetRequest?.payload as { content?: unknown }).content,
      { markdown: "# Official push" },
      "the official string-valued OpenClaw tool contract must send renderer material",
    );

    const cleared = await controller.clear({ fingerprint: "sf_1", paneId });
    assert.equal(cleared.revision, 4);
    assert.equal(cleared.operationReceipt?.requestId, "rq_content.clear");
    const requests = wires.flatMap((wire) => wire.requests);
    const clearRequest = requests.find((request) =>
      request.op === "content.clear"
    );
    assert.deepEqual(clearRequest?.payload, {
      expectedRevision: 3,
      paneId: 1,
      surfaceId: "sf_1",
    });

    const removed = await controller.annotateRemove({
      contentId: "ct_1",
      fingerprint: "sf_1",
      paneId,
      strokeIds: ["st_1"],
    });
    assert.deepEqual(removed.removedStrokeIds, ["st_1"]);

    const snapshot = await controller.snapshot({
      fingerprint: "sf_1",
      paneId,
    });
    assert.equal(snapshot.snapshot?.contentId, "ct_1");

    const capture = await controller.capturePane({
      fingerprint: "sf_1",
      paneId,
    });
    assert.equal(capture.capture.bytesBase64, "aW1hZ2U=");

    await controller.renamePane({
      expectedTopologyRevision: 4,
      fingerprint: "sf_1",
      name: "Primary",
      paneId,
    });
    await controller.restorePane({
      anchorPaneId: paneId,
      direction: "horizontal",
      expectedTopologyRevision: 4,
      fingerprint: "sf_1",
      tombstoneId: "pt_1",
    });
    const realized = await controller.realizeTopologies({
      operations: [{
        allowDestroyPaneIds: [],
        desired: { paneId, type: "pane" },
        expectedTopologyRevision: 4,
        fingerprint: "sf_1",
        operationId: "op_topology",
        target: { root: true },
      }],
    });
    assert.equal(realized.ok, true);
    assert.equal(realized.applied[0]?.operationId, "op_topology");
    assert.deepEqual(
      realized.applied[0]?.destroyedPaneTombstones,
      [{
        closedSequence: 9,
        paneId: "2",
        tombstoneId: "pt_2",
      }],
    );
    const registered = await controller.registerTarget({
      expectedPreviousTargetEpoch: 1,
      fingerprint: "sf_1",
      idempotencyKey: "idem_target",
      paneId,
      registrationState: "attached",
      targetHeader: { payloadSchemaVersion: 1 } as never,
      targetKind: "native_app",
      targetPayload: { appId: "com.example.App" },
    });
    assert.equal(registered.targetId, "tg_registered");
    const restoredTarget = await controller.restoreTarget({
      fingerprint: "sf_1",
      paneId,
    });
    assert.equal(restoredTarget.targetId, "tg_1");
    const launched = await controller.launchNativeApp({
      appId: "com.example.App",
      confirmed: true,
      fingerprint: "sf_1",
      paneId,
    });
    assert.equal(launched.targetId, "tg_registered");

    const read = await controller.read({ fingerprint: "sf_1", paneId });
    assert.equal(read.frames.length, 1);
    assert.deepEqual(read.liveDirtyStrokeIds, ["st_1"]);
    assert.equal(read.taps[0]?.nearestText, "Button");
    assert.equal(read.scrollPosition?.y, 7);
    assert.equal(read.selection?.selectedText, "text");
    assert.equal(read.page?.pageNumber, 2);
    assert.equal(read.playbackState, "playing");
    assert.equal(read.lastNavigation?.url, "https://example.test");
    assert.deepEqual(
      read.consumableRecords?.map((record) => record.recordClass),
      [
        "annotation_frame",
        "tap",
        "content",
        "history",
        "topology",
        "scroll",
        "selection",
        "page",
        "playback",
        "navigation",
      ],
    );

    const available: ControllerWireEnvelope = {
      op: "event.consumable_available",
      payload: { scopeId: "pane:sf_1:1" },
      type: "event",
    };
    wires[1]!.emit(available);
    wires[1]!.emit(available);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      alerts.length,
      1,
      "a pending burst remains alert-suppressed until acknowledged",
    );

    await controller.surfaceIntent({
      action: "close",
      expectedSurfaceSetRevision: 1,
      expectedTopologyRevision: 4,
      fingerprint: "sf_1",
    });
    assert.equal(wires[1]!.closeCount, 1);
    assert.equal(wires[0]!.closeCount, 0);

    await controller.surfaceIntent({
      action: "restore",
      endpointId: "electron-1",
      expectedSurfaceSetRevision: 2,
      tombstoneId: "ts_1",
    });
    assert.equal(wires.length, 3, "restore creates a fresh surface session");
  } finally {
    await controller.stop();
  }
});

test("lockless read and close preserve restored pane identity after visible relabeling", async () => {
  const endpoint: SurfAceDiscoveryEndpoint = {
    busy: false,
    capabilitiesBitmask: 0,
    endpointId: "electron-restored-pane",
    fingerprintPrefix: "sf",
    host: "127.0.0.1",
    instanceName: "Surf Ace",
    lastSeenAt: 1,
    name: "Studio",
    port: 17_700,
    protocolVersion: 1,
    viewport: { height: 768, scale: 1, width: 1024 },
    wsPath: "/ws",
  };
  const endpointState = {
    displayId: "display:restored:visible-2",
    live: true,
    paneAddress: "pane:restored:visible-2",
    paneId: 41,
    paneLabel: 2,
  };
  const wires: LocklessFakeWire[] = [];
  const controller = new OpenClawLocklessController({
    discovery: new StaticDiscovery(endpoint),
    stateDir: "/unused",
    storeFactory: () => new MemoryStore(),
    wireFactory: () => {
      const wire = new LocklessFakeWire(wires.length > 0, endpointState);
      wires.push(wire);
      return wire;
    },
  });
  await controller.start();
  try {
    const paneId = "41" as PaneId;
    const read = await controller.read({ fingerprint: "sf_1", paneId });
    assert.deepEqual({
      displayId: read.displayId,
      paneAddress: read.paneAddress,
      paneId: read.paneId,
      paneLabel: read.paneLabel,
    }, {
      displayId: "display:restored:visible-2",
      paneAddress: "pane:restored:visible-2",
      paneId,
      paneLabel: 2,
    });

    const closed = await controller.closePane({
      expectedTopologyRevision: 4,
      fingerprint: "sf_1",
      paneId,
    });
    assert.deepEqual(closed, {
      displayId: "display:restored:visible-2",
      ok: true,
      operationReceipt: {
        clientResultIds: { paneId: 41, topologyRevision: 5 },
        operation: "pane.close",
        requestId: "rq_pane.close",
      },
      paneAddress: "pane:restored:visible-2",
      paneId,
      paneLabel: 2,
    });
    assert.deepEqual(
      wires.flatMap((wire) => wire.requests).find((request) =>
        request.op === "pane.close"
      )?.payload,
      {
        expectedTopologyRevision: 4,
        paneId: 41,
        surfaceId: "sf_1",
      },
    );
  } finally {
    await controller.stop();
  }
});

test("stale topology intent reports authoritative state without retry or revision substitution", async () => {
  const endpoint: SurfAceDiscoveryEndpoint = {
    busy: false,
    capabilitiesBitmask: 0,
    endpointId: "electron-stale",
    fingerprintPrefix: "sf",
    host: "127.0.0.1",
    instanceName: "Surf Ace",
    lastSeenAt: 1,
    name: "Studio",
    port: 17_700,
    protocolVersion: 1,
    viewport: { height: 768, scale: 1, width: 1024 },
    wsPath: "/ws",
  };
  const stores = new Map<string, MemoryStore>();
  const wires: LocklessFakeWire[] = [];
  const endpointState = {
    live: true,
    staleTopologyOnce: true,
    topologyRevision: 4,
  };
  const controller = new OpenClawLocklessController({
    alertDelivery: async () => {},
    discovery: new StaticDiscovery(endpoint),
    stateDir: "/unused",
    storeFactory: (filePath) => {
      const existing = stores.get(filePath);
      if (existing) {
        return existing;
      }
      const created = new MemoryStore();
      stores.set(filePath, created);
      return created;
    },
    wireFactory: () => {
      const wire = new LocklessFakeWire(wires.length > 0, endpointState);
      wires.push(wire);
      return wire;
    },
  });

  await controller.start();
  try {
    const result = await controller.realizeTopologies({
      operations: [{
        allowDestroyPaneIds: [],
        desired: { paneId: "1" as PaneId, type: "pane" },
        expectedTopologyRevision: 4,
        fingerprint: "sf_1",
        operationId: "op_stale",
        target: { root: true },
      }],
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail("stale topology must fail");
    }
    assert.equal(result.failed.code, "stale_topology");
    assert.match(result.failed.message, /currentTopologyRevision":9/);
    assert.match(result.failed.message, /recompute the intent and submit a new request/);
    const topologyRequests = wires
      .flatMap((wire) => wire.requests)
      .filter((request) => request.op === "topology.apply");
    assert.equal(topologyRequests.length, 1);
    assert.equal(
      (topologyRequests[0]?.payload as { expectedTopologyRevision?: number })
        .expectedTopologyRevision,
      4,
    );
  } finally {
    await controller.stop();
  }
});
