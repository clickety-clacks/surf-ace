import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import WebSocket from "ws";

import {
  LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
  LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES,
  SURF_ACE_LOCKLESS_V1_CAPABILITY,
  locklessPaneScopeId,
} from "../../protocol/src/lockless.js";
import { SurfaceCore } from "../src/surface-core.js";
import {
  DEFAULT_LOCKLESS_LIMITS,
  createEmptyLocklessClientState,
} from "../src/lockless-client-authority.js";
import { PersistentStateOutcomeUnknownError } from "../src/persistent-state-file.js";
import {
  loadPersistentStateFile,
  writePersistentStateFile,
} from "../src/persistent-state-file.js";
import { SurfaceWsServer } from "../src/ws-server.js";
import {
  OpenClawLocklessController,
} from "../../extension/src/openclaw-lockless-controller.js";
import type {
  SurfAceDiscoveryEndpoint,
  SurfAceDiscoveryService,
} from "../../extension/src/surf-ace-discovery.js";

let nextPort = 25901;

class CopiedRootDiscovery implements SurfAceDiscoveryService {
  private listener: ((endpoints: SurfAceDiscoveryEndpoint[]) => void) | null = null;

  constructor(private readonly endpoint: SurfAceDiscoveryEndpoint) {}

  getSnapshot(): SurfAceDiscoveryEndpoint[] {
    return [this.endpoint];
  }

  async refreshNow(): Promise<void> {}

  async start(): Promise<void> {
    this.listener?.([this.endpoint]);
  }

  async stop(): Promise<void> {}

  subscribe(listener: (endpoints: SurfAceDiscoveryEndpoint[]) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
}

function copiedRootEndpoint(port: number): SurfAceDiscoveryEndpoint {
  return {
    busy: false,
    capabilitiesBitmask: 0,
    endpointId: "electron-copied-root",
    fingerprintPrefix: "sf",
    host: "127.0.0.1",
    instanceName: "Surf Ace",
    lastSeenAt: Date.now(),
    name: "Surf Ace",
    port,
    protocolVersion: 1,
    viewport: { height: 800, scale: 2, width: 1200 },
    wsPath: "/ws",
  };
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function request(
  socket: WebSocket,
  op: string,
  payload: Record<string, unknown>,
  options?: { id?: string; sentAt?: number },
): Promise<Record<string, any>> {
  const id =
    options?.id ?? `rq_${Math.random().toString(16).slice(2)}`;
  const result = new Promise<Record<string, any>>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as Record<string, any>;
      if (message.type !== "response" || message.id !== id) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
  socket.send(
    JSON.stringify({
      id,
      op,
      payload,
      sentAt: options?.sentAt ?? Date.now(),
      type: "request",
      v: 1,
    }),
  );
  return result;
}

function nextEvent(
  socket: WebSocket,
  op: string,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as Record<string, any>;
      if (message.type !== "event" || message.op !== op) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function pair(
  socket: WebSocket,
  controllerInstanceId: string,
  surfaceId?: string,
): Promise<Record<string, any>> {
  return request(socket, "pair.request", {
    controllerInstanceId,
    controllerProductName:
      controllerInstanceId === "tight-beam" ? "Tight Beam" : "OpenClaw",
    projectionCapacityBytes: 5 * 1024 * 1024,
    protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
    protocolVersion: 1,
    ...(surfaceId ? { surfaceId } : {}),
  });
}

type TargetAdmissionVectorCase = {
  id: string;
  input: {
    annotationPolicy: "allow" | "deny";
    controllerScenario: "single" | "two_same_request_id";
    paneLineage: "current" | "stale";
    replaySemantics: "navigate" | "replace";
    requiredCapability: "supported" | "missing";
    surfaceState: "live" | "tombstoned";
    targetPayload: "safe_https" | "unsafe_file";
  };
  expected: {
    materializerCalls: number;
    notCommitted: boolean;
    receiptDelta: number;
    receiptSyncOutcome: "not_committed" | "resolved_success";
    resultDelta: number;
    targetErrorCode: string | null;
    topLevelCode: string | null;
    workDelta: number;
  };
};

function targetAdmissionVectorCases(): TargetAdmissionVectorCase[] {
  const vectors = JSON.parse(
    readFileSync(
      new URL("../../../protocol/vectors/authority-conformance.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Array<{ cases?: TargetAdmissionVectorCase[]; id: string }> };
  const vector = vectors.vectors.find(
    (candidate) => candidate.id === "lockless-target-precommit-rejection-classification",
  );
  assert.ok(vector?.cases);
  return vector.cases;
}

function targetAuthorityCounts(core: SurfaceCore): {
  receipts: number;
  results: number;
  work: number;
} {
  const state = core.locklessAuthority.exportState();
  return {
    receipts: Object.values(state.controllers).reduce(
      (total, controller) =>
        total + Object.keys(controller.pendingOperationReceipts).length,
      0,
    ),
    results: Object.values(state.scopes).reduce(
      (total, scope) =>
        total + scope.records.filter(
          (record) => record.recordClass === "target_result",
        ).length,
      0,
    ),
    work: Object.keys(state.targetApplyWorkItems).length,
  };
}

async function waitForTargetCounts(
  core: SurfaceCore,
  expected: { results: number; work: number },
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const counts = targetAuthorityCounts(core);
    if (counts.results === expected.results && counts.work === expected.work) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.deepEqual(
    {
      results: targetAuthorityCounts(core).results,
      work: targetAuthorityCounts(core).work,
    },
    expected,
  );
}

test("canonical target-admission cases execute Electron authority semantics", async () => {
  for (const vectorCase of targetAdmissionVectorCases()) {
    const core = new SurfaceCore();
    const surface = core.ensurePrimarySurface("Surf Ace", {
      height: 800,
      scale: 2,
      width: 1200,
    });
    const port = nextPort++;
    const server = new SurfaceWsServer({
      capturePaneImage: async () => null,
      compositorSocketPath: null,
      core,
      endpointName: "Surf Ace",
      hostName: "localhost",
      port,
      viewport: () => ({ height: 800, scale: 2, width: 1200 }),
    });
    let materializerCalls = 0;
    const targetApply = core.targetApply.bind(core);
    core.targetApply = ((...arguments_: Parameters<SurfaceCore["targetApply"]>) => {
      materializerCalls += 1;
      return targetApply(...arguments_);
    }) as SurfaceCore["targetApply"];
    await server.start();
    const first = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
    const second = vectorCase.input.controllerScenario === "two_same_request_id"
      ? await connect(`ws://127.0.0.1:${port}${server.wsPath}`)
      : null;
    try {
      assert.equal((await pair(first, "controller-a", surface.surfaceId)).ok, true);
      if (second) {
        assert.equal((await pair(second, "controller-b", surface.surfaceId)).ok, true);
      }
      let panes = (await request(first, "panes.list", {
        surfaceId: surface.surfaceId,
      })).payload.panes as Array<{ paneId: number; paneLineageId: string }>;
      if (second) {
        const split = await request(first, "pane.split", {
          count: 2,
          direction: "horizontal",
          expectedTopologyRevision: 0,
          paneId: panes[0]!.paneId,
          surfaceId: surface.surfaceId,
        });
        assert.equal(split.ok, true, `${vectorCase.id}: ${JSON.stringify(split)}`);
        panes = (await request(first, "panes.list", {
          surfaceId: surface.surfaceId,
        })).payload.panes;
      }
      if (vectorCase.input.annotationPolicy === "deny") {
        core.setAnnotating(surface.surfaceId, panes[0]!.paneId, true);
      }
      if (vectorCase.input.surfaceState === "tombstoned") {
        const record = core.captureSurfaceTombstonePayload(surface.surfaceId);
        const paneTombstones = core.locklessAuthority.takePaneTombstonesForSurface(
          surface.surfaceId,
        );
        core.locklessAuthority.createTombstone({
          kind: "surface",
          payload: { paneTombstones, surface: record },
          surfaceId: surface.surfaceId,
        });
        core.removeSurface(surface.surfaceId);
      }
      const before = targetAuthorityCounts(core);
      const operationRequestId = second
        ? "rq-shared-controller-scoped"
        : `rq-${vectorCase.id}`;
      const payloadFor = (pane: { paneId: number; paneLineageId: string }, suffix: string) => ({
        paneLineageId: vectorCase.input.paneLineage === "current"
          ? pane.paneLineageId
          : "pl_stale",
        requestId: `target-${vectorCase.id}-${suffix}`,
        restoreReason: "initial",
        surfaceId: surface.surfaceId,
        targetEpoch: 1,
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: vectorCase.input.replaySemantics,
          requiredCapabilities: [vectorCase.input.requiredCapability === "supported"
            ? "target.browser_url.v1"
            : "target.missing.v1"],
          safeToLogFields: ["url"],
          safetyClass: "network",
          summary: vectorCase.id,
        },
        targetId: `target-${vectorCase.id}-${suffix}`,
        targetKind: "browser_url",
        targetPayload: {
          url: vectorCase.input.targetPayload === "safe_https"
            ? `https://example.com/${suffix}`
            : "file:///etc/passwd",
        },
      });
      const responses = await Promise.all([
        request(first, "target.apply", payloadFor(panes[0]!, "a"), {
          id: operationRequestId,
        }),
        ...(second
          ? [request(second, "target.apply", payloadFor(panes[1]!, "b"), {
              id: operationRequestId,
            })]
          : []),
      ]);
      for (const response of responses) {
        assert.equal(
          response.ok ? null : response.error.code,
          vectorCase.expected.topLevelCode,
          `${vectorCase.id}: ${JSON.stringify(response)}`,
        );
        assert.equal(
          response.error?.details?.targetErrorCode ?? null,
          vectorCase.expected.targetErrorCode,
          `${vectorCase.id}: ${JSON.stringify(response)}`,
        );
      }
      if (!vectorCase.expected.notCommitted) {
        await waitForTargetCounts(core, {
          results: before.results,
          work: before.work + responses.length,
        });
        for (const [index, pane] of panes.slice(0, responses.length).entries()) {
          server.resolveBrowserUrlNavigation(surface.surfaceId, pane.paneId, {
            status: "applied",
            targetId: `target-${vectorCase.id}-${index === 0 ? "a" : "b"}`,
            url: `https://example.com/${index === 0 ? "a" : "b"}`,
          });
        }
      }
      await waitForTargetCounts(core, {
        results: before.results + vectorCase.expected.resultDelta,
        work: before.work + vectorCase.expected.workDelta,
      });
      const after = targetAuthorityCounts(core);
      assert.equal(after.receipts - before.receipts, vectorCase.expected.receiptDelta, vectorCase.id);
      assert.equal(after.work - before.work, vectorCase.expected.workDelta, vectorCase.id);
      assert.equal(after.results - before.results, vectorCase.expected.resultDelta, vectorCase.id);
      assert.equal(materializerCalls, vectorCase.expected.materializerCalls, vectorCase.id);
      for (const socket of [first, ...(second ? [second] : [])]) {
        const sync = await request(socket, "operation.receipt.sync", {
          requestIds: [operationRequestId],
        });
        assert.equal(
          sync.payload.resolutions[0].outcome,
          vectorCase.expected.receiptSyncOutcome,
          vectorCase.id,
        );
      }
    } finally {
      first.close();
      second?.close();
      await server.stop();
    }
  }
});

test("AC-TOPO-04: split rename resize close restore and realization share stable IDs and one topology revision seam", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const first = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const second = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const firstPair = await pair(first, "openclaw", surface.surfaceId);
    const secondPair = await pair(second, "tight-beam", surface.surfaceId);
    assert.equal(firstPair.ok, true, JSON.stringify(firstPair));
    assert.equal(secondPair.ok, true, JSON.stringify(secondPair));
    assert.equal(firstPair.payload.mode, "lockless");
    assert.equal(
      firstPair.payload.capabilities.protocolFeatures.includes(
        SURF_ACE_LOCKLESS_V1_CAPABILITY,
      ),
      true,
    );

    const listed = await request(first, "surfaces.list", {});
    assert.equal(listed.payload.surfaces[0].surfaceId, surface.surfaceId);
    const panes = await request(first, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const paneId = Number(panes.payload.panes[0].paneId);

    const observedBySecond = nextEvent(
      second,
      "event.lockless_content_committed",
    );
    const committed = await request(first, "content.set", {
      content: { markdown: "# shared" },
      contentId: "content-shared",
      contentType: "markdown",
      friendlyChatName: "OpenClaw",
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.equal(committed.payload.revision, 1);
    assert.match(committed.payload.historyEntryId, /^he_/);
    assert.equal(committed.payload.operationReceipt.requestId.startsWith("rq_"), true);
    assert.equal(committed.payload.operationReceipt.commitSequence > 0, true);
    const observedCommit = await observedBySecond;
    assert.equal(observedCommit.payload.contentId, "content-shared");
    assert.equal(
      observedCommit.payload.historyEntryId,
      committed.payload.historyEntryId,
    );

    for (const [contentId, revision] of [
      ["content-second", 2],
      ["content-third", 3],
    ] as const) {
      const next = await request(first, "content.set", {
        content: { markdown: `# ${contentId}` },
        contentId,
        contentType: "markdown",
        paneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.equal(next.payload.revision, revision);
    }
    core.navigateHistory(surface.surfaceId, paneId, "back");
    const divergentPayload = {
      content: { markdown: "# divergent" },
      contentId: "content-divergent",
      contentType: "markdown",
      paneId,
      surfaceId: surface.surfaceId,
    };
    const divergent = await request(
      first,
      "content.set",
      divergentPayload,
      { id: "rq-divergent-replay", sentAt: 100 },
    );
    assert.equal(divergent.ok, true, JSON.stringify(divergent));
    assert.equal(divergent.payload.revision, 4);
    const replayed = await request(
      first,
      "content.set",
      divergentPayload,
      { id: "rq-divergent-replay", sentAt: 200 },
    );
    assert.deepEqual(replayed, divergent);

    const split = await request(second, "pane.split", {
      count: 2,
      direction: "horizontal",
      expectedTopologyRevision: panes.payload.topology.topologyRevision,
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(split.ok, true, JSON.stringify(split));
    assert.equal(split.payload.panes.length, 2);
    const createdPaneId = split.payload.panes.find(
      (pane: { paneId: number }) => pane.paneId !== paneId,
    ).paneId;
    const closed = await request(first, "pane.close", {
      expectedTopologyRevision: split.payload.topologyRevision,
      paneId: createdPaneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(closed.payload.recoverable, true);
    const restored = await request(second, "pane.restore", {
      anchorPaneId: paneId,
      direction: "vertical",
      expectedTopologyRevision: closed.payload.topologyRevision,
      surfaceId: surface.surfaceId,
      tombstoneId: closed.payload.tombstoneId,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.payload.paneId, createdPaneId);

    const createdLifecycleEvent = nextEvent(
      second,
      "event.pane_created",
    );
    const realized = await request(first, "topology.apply", {
      allowDestroyPaneIds: [],
      desired: {
        children: [
          { paneId, type: "pane" },
          { paneId: createdPaneId, type: "pane" },
          { name: "Allocated by Surf Ace", type: "pane" },
        ],
        direction: "horizontal",
        type: "split",
      },
      expectedTopologyRevision: restored.payload.topologyRevision,
      surfaceId: surface.surfaceId,
      target: { root: true },
    });
    assert.equal(realized.ok, true, JSON.stringify(realized));
    assert.equal(realized.payload.topologyRevision, 4);
    assert.equal(realized.payload.panes.length, 3);
    const allocatedPaneId = realized.payload.panes.find(
      (candidate: { paneId: number }) =>
        candidate.paneId !== paneId &&
        candidate.paneId !== createdPaneId,
    ).paneId;
    assert.deepEqual(realized.payload.createdPaneIds, [allocatedPaneId]);
    assert.deepEqual(realized.payload.destroyedPaneIds, []);
    assert.deepEqual(realized.payload.destroyedPaneTombstones, []);
    assert.deepEqual(
      [...realized.payload.preservedPaneIds].sort((a, b) => a - b),
      [paneId, createdPaneId].sort((a, b) => a - b),
    );
    assert.deepEqual(realized.payload.topology, {
      children: [
        { paneId, type: "pane" },
        { paneId: createdPaneId, type: "pane" },
        { paneId: allocatedPaneId, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    });
    assert.equal(
      (await createdLifecycleEvent).payload.paneId,
      allocatedPaneId,
    );

    const registered = await request(second, "target.register", {
      expectedPreviousTargetEpoch: null,
      idempotencyKey: "register-existing-pane",
      launchedAt: new Date().toISOString(),
      paneId,
      registrationState: "before_attach",
      surfaceId: surface.surfaceId,
      targetHeader: {},
      targetKind: "markdown",
      targetPayload: { markdown: "# target" },
    });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    assert.equal(registered.payload.registered, true);
    assert.equal(registered.payload.paneId, paneId);
    assert.match(registered.payload.paneLineageId, /^pl_/);
    assert.match(registered.payload.target.targetId, /^tg_/);
    assert.equal(registered.payload.target.targetEpoch, 1);
    assert.equal(registered.payload.target.targetKind, "markdown");
    assert.deepEqual(registered.payload.target.targetPayload, {
      markdown: "# target",
    });
    const registeredProjection = await request(first, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    assert.equal(
      registeredProjection.payload.panes.find(
        (candidate: { paneId: number }) =>
          Number(candidate.paneId) === paneId,
      ).currentTarget.targetId,
      registered.payload.target.targetId,
    );
    const duplicateRegistration = await request(
      first,
      "target.register",
      {
        expectedPreviousTargetEpoch: null,
        idempotencyKey: "register-existing-pane",
        launchedAt: new Date().toISOString(),
        paneId,
        registrationState: "before_attach",
        surfaceId: surface.surfaceId,
        targetHeader: {},
        targetKind: "markdown",
        targetPayload: { markdown: "# target" },
      },
    );
    assert.equal(
      duplicateRegistration.payload.target.targetId,
      registered.payload.target.targetId,
    );

    const rejectedPreflight = await request(first, "target.apply", {
      paneId,
      requestId: "target-routing-proof",
      restoreReason: "initial",
      surfaceId: surface.surfaceId,
      targetEpoch: 1,
      targetHeader: {},
      targetId: "target-routing-proof",
      targetKind: "unsupported.for-test",
      targetPayload: {},
    });
    assert.equal(rejectedPreflight.ok, false, JSON.stringify(rejectedPreflight));
    assert.equal(rejectedPreflight.error.code, "unsupported_operation");
    const rejectedReceipt = await request(first, "operation.receipt.sync", {
      requestIds: [rejectedPreflight.id],
    });
    assert.equal(rejectedReceipt.payload.resolutions[0].outcome, "not_committed");

    let materializationInvocations = 0;
    const applyTarget = core.targetApply.bind(core);
    core.targetApply = ((...arguments_: Parameters<SurfaceCore["targetApply"]>) => {
      materializationInvocations += 1;
      return applyTarget(...arguments_);
    }) as SurfaceCore["targetApply"];
    const materializationResult = nextEvent(
      second,
      "event.target_apply_result",
    );
    const targetApply = await request(first, "target.apply", {
      paneId,
      requestId: "target-browser-materialization",
      restoreReason: "initial",
      surfaceId: surface.surfaceId,
      targetEpoch: 2,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "DEC-TA-01A proof",
      },
      targetId: "target-browser-proof",
      targetKind: "browser_url",
      targetPayload: { url: "https://example.com/" },
    });
    assert.equal(targetApply.ok, true, JSON.stringify(targetApply));
    assert.deepEqual(
      {
        operationRequestId: targetApply.payload.operationRequestId,
        status: targetApply.payload.status,
        surfaceId: targetApply.payload.surfaceId,
        targetEpoch: targetApply.payload.targetEpoch,
        targetId: targetApply.payload.targetId,
        targetRequestId: targetApply.payload.targetRequestId,
      },
      {
        operationRequestId: targetApply.id,
        status: "intent_committed",
        surfaceId: surface.surfaceId,
        targetEpoch: 2,
        targetId: "target-browser-proof",
        targetRequestId: "target-browser-materialization",
      },
    );
    assert.equal(targetApply.payload.operationReceipt.commitSequence > 0, true);
    for (let attempt = 0; materializationInvocations === 0 && attempt < 50; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(materializationInvocations, 1);
    await (server as unknown as {
      continueTargetApplyWorkItem: (
        controllerInstanceId: string,
        operationRequestId: string,
        request: Record<string, unknown>,
        socket: WebSocket,
      ) => Promise<void>;
    }).continueTargetApplyWorkItem(
      "openclaw",
      targetApply.id,
      {
        id: targetApply.id,
        op: "target.apply",
        payload: {
          paneLineageId: registered.paneLineageId,
          requestId: "target-browser-materialization",
          restoreReason: "initial",
          surfaceId: surface.surfaceId,
          targetEpoch: 2,
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "navigate",
            requiredCapabilities: ["target.browser_url.v1"],
            safeToLogFields: ["url"],
            safetyClass: "network",
            summary: "DEC-TA-01A proof",
          },
          targetId: "target-browser-proof",
          targetKind: "browser_url",
          targetPayload: { url: "https://example.com/" },
        },
        sentAt: Date.now(),
        type: "request",
        v: 1,
      },
      first,
    );
    assert.equal(materializationInvocations, 1);
    server.resolveBrowserUrlNavigation(surface.surfaceId, paneId, {
      status: "applied",
      targetId: "target-browser-proof",
      url: "https://example.com/",
    });
    const result = await materializationResult;
    assert.equal(result.payload.status, "applied");
    assert.equal(materializationInvocations, 1);
    assert.equal(
      result.payload.intentCommitSequence,
      targetApply.payload.operationReceipt.commitSequence,
    );
    assert.equal(result.payload.operationRequestId, targetApply.id);
    assert.equal(result.payload.targetRequestId, "target-browser-materialization");
    assert.match(result.payload.recordId, /^cr_/);
    assert.equal(result.payload.consumableSequence > 0, true);
    const receiptReplay = await request(first, "operation.receipt.sync", {
      requestIds: [targetApply.id],
    });
    assert.deepEqual(
      receiptReplay.payload.resolutions[0].terminalResponse,
      targetApply,
    );
    const targetProjection = await request(first, "consumable.sync", {
      scopeIds: [`surface:${encodeURIComponent(surface.surfaceId)}`],
    });
    const projectedResult = targetProjection.payload.snapshots[0].records.find(
      (record: { recordClass: string }) => record.recordClass === "target_result",
    );
    assert.equal(projectedResult.recordId, result.payload.recordId);
    assert.equal(projectedResult.payload.status, "applied");

    const removedLifecycleEvent = nextEvent(
      second,
      "event.pane_removed",
    );
    const removedByTopology = await request(first, "topology.apply", {
      allowDestroyPaneIds: [allocatedPaneId],
      desired: {
        children: [
          { paneId, type: "pane" },
          { paneId: createdPaneId, type: "pane" },
        ],
        direction: "horizontal",
        type: "split",
      },
      expectedTopologyRevision: 4,
      surfaceId: surface.surfaceId,
      target: { root: true },
    });
    assert.equal(removedByTopology.ok, true, JSON.stringify(removedByTopology));
    assert.deepEqual(removedByTopology.payload.createdPaneIds, []);
    assert.deepEqual(removedByTopology.payload.destroyedPaneIds, [
      allocatedPaneId,
    ]);
    assert.deepEqual(
      removedByTopology.payload.preservedPaneIds,
      [paneId, createdPaneId],
    );
    const [removedTombstone] =
      removedByTopology.payload.destroyedPaneTombstones;
    assert.equal(removedTombstone.paneId, allocatedPaneId);
    assert.match(removedTombstone.tombstoneId, /^pt_/);
    assert.equal(removedTombstone.closedSequence > 0, true);
    assert.equal(
      (await removedLifecycleEvent).payload.paneId,
      allocatedPaneId,
    );
    const restoredTopologyPane = await request(first, "pane.restore", {
      anchorPaneId: paneId,
      direction: "horizontal",
      expectedTopologyRevision:
        removedByTopology.payload.topologyRevision,
      surfaceId: surface.surfaceId,
      tombstoneId: removedTombstone.tombstoneId,
    });
    assert.equal(restoredTopologyPane.ok, true, JSON.stringify(restoredTopologyPane));
    assert.equal(restoredTopologyPane.payload.paneId, allocatedPaneId);
    const renamed = await request(second, "pane.rename", {
      expectedTopologyRevision: restoredTopologyPane.payload.topologyRevision,
      name: "Stable allocated pane",
      paneId: allocatedPaneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    assert.equal(renamed.payload.paneId, allocatedPaneId);
    assert.equal(renamed.payload.name, "Stable allocated pane");
    assert.equal(
      renamed.payload.topologyRevision,
      restoredTopologyPane.payload.topologyRevision + 1,
    );
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("restart from materializing terminalizes unknown without re-invoking target materialization", async () => {
  const seed = new SurfaceCore();
  const surface = seed.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  seed.admitSurfaceToLockless(surface.surfaceId);
  seed.locklessAuthority.admit(
    {
      controllerInstanceId: "tight-beam-restart",
      projectionCapacityBytes: 5 * 1024 * 1024,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
    },
    "seed-token",
    "seed-admission",
    `surface:${surface.surfaceId}`,
  );
  const pane = seed.panesList(surface.surfaceId).panes[0];
  const requestId = "target-restart-operation";
  const intent = seed.locklessAuthority.auditAccepted(
    requestId,
    "target.apply",
    "tight-beam-restart",
    surface.surfaceId,
  );
  seed.locklessAuthority.admitTargetApplyWorkItem({
    controllerInstanceId: "tight-beam-restart",
    currentSurfaceBase: seed.captureSurfaceTombstonePayload(
      surface.surfaceId,
    ),
    intentCommitSequence: intent.commitSequence,
    operationRequestId: requestId,
    request: {
      paneId: Number(pane.paneId),
      paneLineageId: String(pane.paneLineageId),
      requestId: "target-restart-materialization",
      restoreReason: "initial",
      surfaceId: surface.surfaceId,
      targetEpoch: 1,
      targetHeader: {},
      targetId: "target-restart",
      targetKind: "native_app",
      targetPayload: { appId: "must-not-run" },
    },
  });
  seed.locklessAuthority.markTargetApplyMaterializing(
    "tight-beam-restart",
    requestId,
  );

  const restored = new SurfaceCore({
    persistentState: seed.getPersistentState(),
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core: restored,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  try {
    assert.deepEqual(restored.locklessAuthority.targetApplyWorkItems(), []);
    const records = restored.locklessAuthority.scopeSnapshot(
      "tight-beam-restart",
      `surface:${encodeURIComponent(surface.surfaceId)}`,
    ).records;
    const result = records.find(
      (record) => record.recordClass === "target_result",
    );
    assert.equal(result?.payload.status, "failed");
    assert.equal(
      result?.payload.errorCode,
      "materialization_outcome_unknown",
    );
    assert.equal(result?.payload.operationRequestId, requestId);
    assert.equal(
      result?.payload.intentCommitSequence,
      intent.commitSequence,
    );
  } finally {
    await server.stop();
  }
});

test("restart from committed target intent persists materializing and invokes exactly once", async () => {
  const seed = new SurfaceCore();
  const surface = seed.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  seed.admitSurfaceToLockless(surface.surfaceId);
  seed.locklessAuthority.admit(
    {
      controllerInstanceId: "tight-beam-restart-intent",
      projectionCapacityBytes: 5 * 1024 * 1024,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
    },
    "seed-intent-token",
    "seed-intent-admission",
    `surface:${surface.surfaceId}`,
  );
  const pane = seed.panesList(surface.surfaceId).panes[0];
  const requestId = "target-restart-intent-operation";
  const intent = seed.locklessAuthority.auditAccepted(
    requestId,
    "target.apply",
    "tight-beam-restart-intent",
    surface.surfaceId,
  );
  seed.locklessAuthority.admitTargetApplyWorkItem({
    controllerInstanceId: "tight-beam-restart-intent",
    currentSurfaceBase: seed.captureSurfaceTombstonePayload(
      surface.surfaceId,
    ),
    intentCommitSequence: intent.commitSequence,
    operationRequestId: requestId,
    request: {
      paneId: Number(pane.paneId),
      paneLineageId: String(pane.paneLineageId),
      requestId: "target-restart-native-materialization",
      restoreReason: "initial",
      surfaceId: surface.surfaceId,
      targetEpoch: 1,
      targetHeader: {},
      targetId: "target-restart-native",
      targetKind: "native_app",
      targetPayload: { appId: "restart-native-proof" },
    },
  });

  const restored = new SurfaceCore({
    persistentState: seed.getPersistentState(),
  });
  let materializationInvocations = 0;
  const projectMaterialization =
    restored.projectNativePaneMaterialization.bind(restored);
  restored.projectNativePaneMaterialization = ((
    ...arguments_: Parameters<SurfaceCore["projectNativePaneMaterialization"]>
  ) => {
    materializationInvocations += 1;
    return projectMaterialization(...arguments_);
  }) as SurfaceCore["projectNativePaneMaterialization"];
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core: restored,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  try {
    assert.deepEqual(restored.locklessAuthority.targetApplyWorkItems(), []);
    const records = restored.locklessAuthority.scopeSnapshot(
      "tight-beam-restart-intent",
      `surface:${encodeURIComponent(surface.surfaceId)}`,
    ).records;
    const results = records.filter(
      (record) => record.recordClass === "target_result",
    );
    assert.equal(results.length, 1);
    assert.equal(materializationInvocations, 1);
    assert.notEqual(
      results[0]?.payload.errorCode,
      "materialization_outcome_unknown",
    );
    assert.equal(results[0]?.payload.operationRequestId, requestId);
    assert.equal(
      results[0]?.payload.intentCommitSequence,
      intent.commitSequence,
    );
  } finally {
    await server.stop();
  }
});

test("target intent persistence completes before response and materialization callback", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  let gatePersistence = false;
  let releasePersistence: (() => void) | null = null;
  let materializationInvocations = 0;
  const targetApply = core.targetApply.bind(core);
  core.targetApply = ((...arguments_: Parameters<SurfaceCore["targetApply"]>) => {
    materializationInvocations += 1;
    return targetApply(...arguments_);
  }) as SurfaceCore["targetApply"];
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      if (!gatePersistence) return;
      await new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(socket, "tight-beam", surface.surfaceId)).ok, true);
    const panes = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const paneId = Number(panes.payload.topology.panes[0].paneId);
    gatePersistence = true;
    const resultEvent = nextEvent(socket, "event.target_apply_result");
    const responsePromise = request(socket, "target.apply", {
      paneId,
      requestId: "target-persistence-materialization",
      restoreReason: "initial",
      surfaceId: surface.surfaceId,
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "persistence gate",
      },
      targetId: "target-persistence",
      targetKind: "browser_url",
      targetPayload: { url: "https://example.com/" },
    });
    const early = await Promise.race([
      responsePromise.then(() => "response"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("withheld"), 25)
      ),
    ]);
    assert.equal(early, "withheld");
    assert.equal(materializationInvocations, 0);
    assert.ok(releasePersistence);
    gatePersistence = false;
    releasePersistence();
    const response = await responsePromise;
    assert.equal(response.payload.status, "intent_committed");
    server.resolveBrowserUrlNavigation(surface.surfaceId, paneId, {
      status: "applied",
      targetId: "target-persistence",
      url: "https://example.com/",
    });
    const result = await resultEvent;
    assert.equal(materializationInvocations, 1);
    assert.equal(result.payload.status, "applied");
    assert.equal(
      result.payload.intentCommitSequence,
      response.payload.operationReceipt.commitSequence,
    );
  } finally {
    socket.close();
    await server.stop();
  }
});

test("unknown persistence outcome closes transport without a terminal answer and fail-stops later authority", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  let failPersistence = false;
  let materializationInvocations = 0;
  const targetApply = core.targetApply.bind(core);
  core.targetApply = ((...arguments_: Parameters<SurfaceCore["targetApply"]>) => {
    materializationInvocations += 1;
    return targetApply(...arguments_);
  }) as SurfaceCore["targetApply"];
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      if (failPersistence) {
        throw new PersistentStateOutcomeUnknownError(new Error("injected selector ambiguity"));
      }
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(socket, "tight-beam", surface.surfaceId)).ok, true);
    const panes = await request(socket, "panes.list", { surfaceId: surface.surfaceId });
    const requestId = "target-persistence-outcome-unknown";
    const received: Record<string, any>[] = [];
    socket.on("message", (raw) => received.push(JSON.parse(String(raw))));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: String(reason) }));
    });
    failPersistence = true;
    socket.send(JSON.stringify({
      id: requestId,
      op: "target.apply",
      payload: {
        paneId: Number(panes.payload.panes[0].paneId),
        requestId: "target-materialization-must-not-run",
        restoreReason: "initial",
        surfaceId: surface.surfaceId,
        targetEpoch: 1,
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "navigate",
          requiredCapabilities: ["target.browser_url.v1"],
          safeToLogFields: ["url"],
          safetyClass: "network",
          summary: "must fail stop",
        },
        targetId: "target-fail-stop",
        targetKind: "browser_url",
        targetPayload: { url: "https://example.com/" },
      },
      sentAt: Date.now(),
      type: "request",
      v: 1,
    }));
    const close = await closed;
    assert.equal(close.code, 1011);
    assert.equal(close.reason, "persistence_outcome_unknown");
    assert.equal(received.some((message) => message.id === requestId), false);
    assert.equal(materializationInvocations, 0);
    await assert.rejects(connect(`ws://127.0.0.1:${port}${server.wsPath}`));
  } finally {
    socket.close();
    await server.stop();
  }
});

test("blocked persistence serializes concurrent target intents, ordinary mutation, and acknowledgements", async () => {
  const core = new SurfaceCore();
  const firstSurface = core.ensurePrimarySurface("First", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const secondSurface = core.createAdditionalSurface("Second", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  let gatePersistence = false;
  let releasePersistence = (): void => {};
  let persistenceStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    persistenceStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let blocked = false;
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      if (!gatePersistence || blocked) return;
      blocked = true;
      persistenceStarted();
      await gate;
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const first = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const second = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(first, "controller-first", firstSurface.surfaceId)).ok, true);
    assert.equal((await pair(second, "controller-second", secondSurface.surfaceId)).ok, true);
    const firstPane = Number((await request(first, "panes.list", {
      surfaceId: firstSurface.surfaceId,
    })).payload.panes[0].paneId);
    const secondPane = Number((await request(second, "panes.list", {
      surfaceId: secondSurface.surfaceId,
    })).payload.panes[0].paneId);
    gatePersistence = true;
    const firstTarget = request(first, "target.apply", {
      paneId: firstPane,
      requestId: "materialize-first",
      restoreReason: "initial",
      surfaceId: firstSurface.surfaceId,
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "first",
      },
      targetId: "target-first",
      targetKind: "browser_url",
      targetPayload: { url: "https://first.example/" },
    }, { id: "operation-first" });
    await started;
    const secondTarget = request(second, "target.apply", {
      paneId: secondPane,
      requestId: "materialize-second",
      restoreReason: "initial",
      surfaceId: secondSurface.surfaceId,
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "second",
      },
      targetId: "target-second",
      targetKind: "browser_url",
      targetPayload: { url: "https://second.example/" },
    }, { id: "operation-second" });
    const ordinary = request(second, "content.set", {
      content: { markdown: "queued" },
      contentId: "queued-content",
      contentType: "markdown",
      paneId: secondPane,
      surfaceId: secondSurface.surfaceId,
    }, { id: "operation-ordinary" });
    const early = await Promise.race([
      Promise.any([firstTarget, secondTarget, ordinary]).then(() => "response"),
      new Promise<string>((resolve) => setTimeout(() => resolve("withheld"), 25)),
    ]);
    assert.equal(early, "withheld");
    releasePersistence();
    const [firstResponse, secondResponse, ordinaryResponse] = await Promise.all([
      firstTarget,
      secondTarget,
      ordinary,
    ]);
    assert.equal(firstResponse.payload.status, "intent_committed");
    assert.equal(secondResponse.payload.status, "intent_committed");
    assert.equal(ordinaryResponse.ok, true, JSON.stringify(ordinaryResponse));
    assert.ok(
      firstResponse.payload.operationReceipt.commitSequence <
        secondResponse.payload.operationReceipt.commitSequence,
    );
    assert.ok(
      secondResponse.payload.operationReceipt.commitSequence <
        ordinaryResponse.payload.operationReceipt.commitSequence,
    );
    assert.notEqual(firstResponse.error?.code, "internal_error");
    assert.notEqual(secondResponse.error?.code, "internal_error");

    const receiptAck = request(first, "operation.receipt.ack", {
      requestId: "operation-first",
    });
    const consumableAck = request(second, "consumable.ack", {
      cursor: 1,
      scopeId: `surface:${encodeURIComponent(secondSurface.surfaceId)}`,
    });
    assert.equal((await receiptAck).payload.accepted, true);
    assert.equal((await consumableAck).ok, true);

    const firstResult = nextEvent(first, "event.target_apply_result");
    const secondResult = nextEvent(second, "event.target_apply_result");
    server.resolveBrowserUrlNavigation(firstSurface.surfaceId, firstPane, {
      status: "applied",
      targetId: "target-first",
      url: "https://first.example/",
    });
    server.resolveBrowserUrlNavigation(secondSurface.surfaceId, secondPane, {
      status: "applied",
      targetId: "target-second",
      url: "https://second.example/",
    });
    assert.equal((await firstResult).payload.status, "applied");
    assert.equal((await secondResult).payload.status, "applied");
    const firstResultRecords = core.locklessAuthority.scopeSnapshot(
      "controller-first",
      `surface:${encodeURIComponent(firstSurface.surfaceId)}`,
    ).records.filter((record) => record.recordClass === "target_result");
    const secondResultRecords = core.locklessAuthority.scopeSnapshot(
      "controller-second",
      `surface:${encodeURIComponent(secondSurface.surfaceId)}`,
    ).records.filter((record) => record.recordClass === "target_result");
    assert.equal(firstResultRecords.length, 1);
    assert.equal(firstResultRecords[0].payload.operationRequestId, "operation-first");
    assert.equal(secondResultRecords.length, 1);
    assert.equal(secondResultRecords[0].payload.operationRequestId, "operation-second");
    assert.deepEqual(core.locklessAuthority.targetApplyWorkItems(), []);
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("queued topology mutation invalidates a later target before FIFO admission", async () => {
  const core = new SurfaceCore();
  const firstSurface = core.ensurePrimarySurface("First", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const secondSurface = core.createAdditionalSurface("Second", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  let gatePersistence = false;
  let persistenceBlocked = false;
  let releasePersistence = (): void => {};
  let persistenceStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    persistenceStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      if (!gatePersistence || persistenceBlocked) return;
      persistenceBlocked = true;
      persistenceStarted();
      await gate;
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const first = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const second = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(first, "controller-first", firstSurface.surfaceId)).ok, true);
    assert.equal((await pair(second, "controller-second", secondSurface.surfaceId)).ok, true);
    const firstPane = Number((await request(first, "panes.list", {
      surfaceId: firstSurface.surfaceId,
    })).payload.panes[0].paneId);
    const initialSecondPane = Number((await request(second, "panes.list", {
      surfaceId: secondSurface.surfaceId,
    })).payload.panes[0].paneId);
    const split = await request(second, "pane.split", {
      count: 2,
      direction: "horizontal",
      expectedTopologyRevision: 0,
      paneId: initialSecondPane,
      surfaceId: secondSurface.surfaceId,
    });
    assert.equal(split.ok, true, JSON.stringify(split));
    const closingPane = Number(split.payload.panes.find(
      (pane: { paneId: number }) => pane.paneId !== initialSecondPane,
    ).paneId);

    gatePersistence = true;
    const firstTarget = request(first, "target.apply", {
      paneId: firstPane,
      requestId: "materialize-gate",
      restoreReason: "initial",
      surfaceId: firstSurface.surfaceId,
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "gate",
      },
      targetId: "target-gate",
      targetKind: "browser_url",
      targetPayload: { url: "https://gate.example/" },
    }, { id: "operation-gate" });
    await started;
    const close = request(second, "pane.close", {
      expectedTopologyRevision: split.payload.topologyRevision,
      paneId: closingPane,
      surfaceId: secondSurface.surfaceId,
    }, { id: "operation-close" });
    const invalidatedTarget = request(second, "target.apply", {
      paneId: closingPane,
      requestId: "materialize-invalidated",
      restoreReason: "initial",
      surfaceId: secondSurface.surfaceId,
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "invalidated",
      },
      targetId: "target-invalidated",
      targetKind: "browser_url",
      targetPayload: { url: "https://invalidated.example/" },
    }, { id: "operation-invalidated" });
    releasePersistence();
    const [firstResponse, closeResponse, invalidatedResponse] = await Promise.all([
      firstTarget,
      close,
      invalidatedTarget,
    ]);
    assert.equal(firstResponse.payload.status, "intent_committed");
    assert.equal(closeResponse.ok, true, JSON.stringify(closeResponse));
    assert.equal(invalidatedResponse.ok, false, JSON.stringify(invalidatedResponse));
    assert.equal(invalidatedResponse.error.code, "invalid_payload");

    const firstResult = nextEvent(first, "event.target_apply_result");
    server.resolveBrowserUrlNavigation(firstSurface.surfaceId, firstPane, {
      status: "applied",
      targetId: "target-gate",
      url: "https://gate.example/",
    });
    assert.equal((await firstResult).payload.status, "applied");
    assert.deepEqual(core.locklessAuthority.targetApplyWorkItems(), []);
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("terminal mutation response waits for durable receipt persistence and replays until ack", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  let releasePersistence: (() => void) | null = null;
  let persistenceCalls = 0;
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      persistenceCalls += 1;
      if (persistenceCalls === 3) {
        await new Promise<void>((resolve) => {
          releasePersistence = resolve;
        });
      }
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(socket, "tight-beam", surface.surfaceId)).ok, true);
    const panes = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const requestId = "receipt-persistence-gate";
    const mutation = request(socket, "content.set", {
      content: { markdown: "# durable" },
      contentId: "durable-content",
      contentType: "markdown",
      paneId: Number(panes.payload.panes[0].paneId),
      surfaceId: surface.surfaceId,
    }, { id: requestId });
    const early = await Promise.race([
      mutation.then(() => "response"),
      new Promise<string>((resolve) => setTimeout(() => resolve("withheld"), 25)),
    ]);
    assert.equal(early, "withheld");
    assert.equal(persistenceCalls, 3);
    assert.ok(releasePersistence);
    releasePersistence();
    const terminal = await mutation;
    assert.equal(terminal.ok, true, JSON.stringify(terminal));
    assert.deepEqual(terminal.payload.operationReceipt, {
      commitSequence: terminal.payload.operationReceipt.commitSequence,
      requestId,
    });

    const synced = await request(socket, "operation.receipt.sync", {
      requestIds: [requestId, "never-committed"],
    });
    assert.deepEqual(
      synced.payload.resolutions.map((entry: { outcome: string }) => entry.outcome),
      ["resolved_success", "not_committed"],
    );
    assert.deepEqual(
      synced.payload.resolutions[0].terminalResponse,
      terminal,
    );
    const acknowledged = await request(socket, "operation.receipt.ack", {
      requestId,
    });
    assert.equal(acknowledged.payload.accepted, true);
    assert.equal(persistenceCalls, 4);
    const afterAck = await request(socket, "operation.receipt.sync", {
      requestIds: [requestId],
    });
    assert.equal(afterAck.payload.resolutions[0].outcome, "resolved_success");
    const released = await request(socket, "operation.receipt.ack", {
      release: true,
      requestId,
    });
    assert.equal(released.payload.accepted, true);
    assert.equal(released.payload.release, true);
    assert.equal(persistenceCalls, 5);
    const afterRelease = await request(socket, "operation.receipt.sync", {
      requestIds: [requestId],
    });
    assert.equal(afterRelease.payload.resolutions[0].outcome, "not_committed");
    const repeatedRelease = await request(socket, "operation.receipt.ack", {
      release: true,
      requestId,
    });
    assert.equal(repeatedRelease.payload.accepted, true);
  } finally {
    socket.close();
    await server.stop();
  }
});

test("exact terminal receipt capacity rolls back the mutation before commit", async () => {
  const lockless = createEmptyLocklessClientState({
    ...DEFAULT_LOCKLESS_LIMITS,
    maxPendingOperationReceiptBytesPerController: 256,
  });
  const core = new SurfaceCore({
    persistentState: {
      lockless,
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(socket, "tight-beam", surface.surfaceId)).ok, true);
    const before = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const paneId = Number(before.payload.panes[0].paneId);
    const rejected = await request(socket, "content.set", {
      content: { markdown: "# must roll back" },
      contentId: "too-large-receipt",
      contentType: "markdown",
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.error.code, "receipt_capacity");
    const after = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    assert.deepEqual(after.payload.panes, before.payload.panes);
    assert.deepEqual(after.payload.topology, before.payload.topology);
    assert.deepEqual(
      core.locklessAuthority.resolveOperationReceipts(
        "tight-beam",
        [rejected.id],
      ),
      [{ outcome: "not_committed", requestId: rejected.id }],
    );
  } finally {
    socket.close();
    await server.stop();
  }
});

test("one stable controller may hold lifecycle and surface sessions but not duplicate a target", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const lifecycle = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const surfaceSession = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const duplicateSurface = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const lifecyclePair = await pair(lifecycle, "tight-beam");
    assert.equal(lifecyclePair.ok, true, JSON.stringify(lifecyclePair));
    const surfacePair = await pair(
      surfaceSession,
      "tight-beam",
      surface.surfaceId,
    );
    assert.equal(
      surfacePair.ok,
      true,
      JSON.stringify(surfacePair),
    );
    assert.equal(surfacePair.payload.admissionAttempt.outcome, "succeeded");
    const duplicate = await pair(
      duplicateSurface,
      "tight-beam",
      surface.surfaceId,
    );
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, "duplicate_controller_instance");
    assert.deepEqual(
      core.listSurfaceAdmissionAttempts().map((attempt) => ({
        outcome: attempt.outcome,
        reasonCode: attempt.reasonCode,
        stage: attempt.stage,
      })),
      [
        { outcome: "succeeded", reasonCode: null, stage: "mode_commit" },
        {
          outcome: "failed",
          reasonCode: "duplicate_controller_instance",
          stage: "controller_admission",
        },
      ],
    );

    const listed = await request(lifecycle, "surfaces.list", {});
    const surfaceScopedList = await request(surfaceSession, "surfaces.list", {});
    assert.equal(surfaceScopedList.payload.admissionAttempts, undefined);
    const removal = nextEvent(lifecycle, "event.surface_removed");
    const closed = await request(surfaceSession, "surface.window.close", {
      expectedSurfaceSetRevision: listed.payload.surfaceSetRevision,
      expectedTopologyRevision:
        listed.payload.surfaces[0].topology.topologyRevision,
      surfaceId: surface.surfaceId,
    });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    assert.equal((await removal).payload.surfaceId, surface.surfaceId);
    surfaceSession.close();
    await new Promise<void>((resolve) =>
      surfaceSession.once("close", () => resolve()),
    );
    const appeared = nextEvent(lifecycle, "event.surface_appeared");
    const restored = await request(
      lifecycle,
      "surface.window.restore",
      {
        expectedSurfaceSetRevision: closed.payload.surfaceSetRevision,
        tombstoneId: closed.payload.tombstoneId,
      },
    );
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.payload.surfaceId, surface.surfaceId);
    assert.equal((await appeared).payload.surfaceId, surface.surfaceId);
  } finally {
    lifecycle.close();
    surfaceSession.close();
    duplicateSurface.close();
    await server.stop();
  }
});

test("consumable acknowledgements use durable controller scope ownership across admitted connection slots", async () => {
  const core = new SurfaceCore();
  const firstSurface = core.ensurePrimarySurface("First", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const secondSurface = core.createAdditionalSurface("Second", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const firstPaneScope = locklessPaneScopeId(
    firstSurface.surfaceId,
    1,
  );
  const secondSurfaceScope =
    `surface:${encodeURIComponent(secondSurface.surfaceId)}`;
  core.locklessAuthority.ensureScope(firstPaneScope, "pane");
  core.locklessAuthority.ensureScope(secondSurfaceScope, "surface");

  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const lifecycle = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const firstSurfaceSession = await connect(
    `ws://127.0.0.1:${port}${server.wsPath}`,
  );
  try {
    assert.equal((await pair(lifecycle, "durable-controller")).ok, true);
    assert.equal(
      (await pair(
        firstSurfaceSession,
        "durable-controller",
        firstSurface.surfaceId,
      )).ok,
      true,
    );
    core.locklessAuthority.appendConsumable({
      payload: { value: "pane" },
      recordClass: "tap",
      scopeId: firstPaneScope,
      scopeKind: "pane",
      triggerOperation: "test.lifecycle-ack",
    });
    core.locklessAuthority.appendConsumable({
      payload: { value: "other-surface" },
      recordClass: "target_result",
      scopeId: secondSurfaceScope,
      scopeKind: "surface",
      triggerOperation: "test.cross-surface-ack",
    });

    const lifecycleAck = await request(lifecycle, "consumable.ack", {
      cursor: 2,
      scopeId: firstPaneScope,
    });
    assert.equal(lifecycleAck.ok, true, JSON.stringify(lifecycleAck));
    assert.equal(lifecycleAck.payload.acceptedCursor, 2);

    const crossSurfaceAck = await request(
      firstSurfaceSession,
      "consumable.ack",
      {
        cursor: 2,
        scopeId: secondSurfaceScope,
      },
    );
    assert.equal(crossSurfaceAck.ok, true, JSON.stringify(crossSurfaceAck));
    assert.equal(crossSurfaceAck.payload.acceptedCursor, 2);

    const lifecycleSync = await request(lifecycle, "consumable.sync", {
      scopeIds: [firstPaneScope],
    });
    assert.equal(lifecycleSync.ok, false);
    assert.equal(lifecycleSync.error.code, "not_paired");

    const foreignSurfaceList = await request(
      firstSurfaceSession,
      "panes.list",
      { surfaceId: secondSurface.surfaceId },
    );
    assert.equal(foreignSurfaceList.ok, false);
    assert.equal(foreignSurfaceList.error.code, "not_paired");
  } finally {
    lifecycle.close();
    firstSurfaceSession.close();
    await server.stop();
  }
});

test("unknown-surface admission is bounded, durable, and lifecycle-only", async () => {
  let durable: ReturnType<SurfaceCore["getPersistentState"]> | null = null;
  const core = new SurfaceCore();
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      durable = core.getPersistentState();
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const unknown = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const lifecycle = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const oversizedController = await request(
      unknown,
      "pair.request",
      {
        controllerInstanceId: "c".repeat(65),
        projectionCapacityBytes: 1,
        protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
        protocolVersion: 1,
        surfaceId: "sf_unknown",
      },
      { id: "rq_oversized_controller" },
    );
    assert.equal(oversizedController.ok, false);
    assert.equal(core.listSurfaceAdmissionAttempts().length, 0);

    const missing = await request(
      unknown,
      "pair.request",
      {
        controllerInstanceId: "unknown_surface_controller",
        projectionCapacityBytes: 1,
        protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
        protocolVersion: 1,
        surfaceId: "sf_unknown",
      },
      { id: "rq_unknown_surface" },
    );
    assert.equal(missing.ok, false, JSON.stringify(missing));
    assert.equal(missing.error.code, "invalid_payload");
    assert(durable);
    assert.equal(durable.admissionAttempts?.length, 1);
    assert.equal(durable.admissionAttempts?.[0]?.surfaceId, "sf_unknown");
    assert.equal(durable.admissionAttempts?.[0]?.outcome, "failed");

    const lifecyclePair = await pair(lifecycle, "lifecycle_controller");
    assert.equal(lifecyclePair.ok, true, JSON.stringify(lifecyclePair));
    const discovered = await request(lifecycle, "surfaces.list", {});
    assert.equal(discovered.ok, true, JSON.stringify(discovered));
    assert.equal(discovered.payload.admissionAttempts.length, 1);
    assert(
      Buffer.byteLength(
        JSON.stringify(discovered.payload.admissionAttempts),
        "utf8",
      ) <= LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES,
    );

    const surfaceScoped = await connect(
      `ws://127.0.0.1:${port}${server.wsPath}`,
    );
    try {
      const scopedPair = await pair(
        surfaceScoped,
        "surface_scoped_controller",
        "sf_unknown",
      );
      assert.equal(scopedPair.ok, false);
      assert.equal(
        (scopedPair.payload as Record<string, unknown> | undefined)
          ?.admissionAttempts,
        undefined,
      );
    } finally {
      surfaceScoped.close();
    }
  } finally {
    lifecycle.close();
    unknown.close();
    await server.stop();
  }

  assert(durable);
  const restarted = new SurfaceCore({ persistentState: durable });
  assert.equal(restarted.listSurfaceAdmissionAttempts().length, 2);
  assert.deepEqual(
    restarted.listSurfaceAdmissionAttempts().map((attempt) => attempt.outcome),
    ["failed", "failed"],
  );
});

test("three surfaces recover independently and complete the offline push-capture path", async () => {
  const core = new SurfaceCore();
  const surfaces = [
    core.ensurePrimarySurface("Already Lockless", {
      height: 800,
      scale: 2,
      width: 1200,
    }),
    core.createAdditionalSurface("Second Surface", {
      height: 800,
      scale: 2,
      width: 1200,
    }),
    core.createAdditionalSurface("Third Surface", {
      height: 800,
      scale: 2,
      width: 1200,
    }),
  ];
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async (surfaceId, paneId) =>
      Buffer.from(`${surfaceId}:${paneId}`).toString("base64"),
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const lifecycle = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const surfaceSockets = await Promise.all(
    surfaces.map(() => connect(`ws://127.0.0.1:${port}${server.wsPath}`)),
  );
  try {
    assert.equal((await pair(lifecycle, "three-surface-controller")).ok, true);

    const firstAdmission = await pair(
      surfaceSockets[0]!,
      "three-surface-controller",
      surfaces[0]!.surfaceId,
    );
    assert.equal(firstAdmission.ok, true, JSON.stringify(firstAdmission));

    for (const index of [1, 2]) {
      const admitted = await pair(
        surfaceSockets[index]!,
        "three-surface-controller",
        surfaces[index]!.surfaceId,
      );
      assert.equal(admitted.ok, true, JSON.stringify(admitted));
    }

    for (const [index, surface] of surfaces.entries()) {
      const panes = await request(surfaceSockets[index]!, "panes.list", {
        surfaceId: surface.surfaceId,
      });
      assert.equal(panes.ok, true, JSON.stringify(panes));
      const paneId = panes.payload.panes[0].paneId;
      assert(Number(paneId) > 0);
      const contentId = `three-surface-${index + 1}`;
      const pushed = await request(surfaceSockets[index]!, "content.set", {
        content: { markdown: `# ${contentId}` },
        contentId,
        contentType: "markdown",
        paneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(pushed.ok, true, JSON.stringify(pushed));
      const captured = await request(surfaceSockets[index]!, "snapshot.get", {
        includeImage: true,
        paneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(captured.ok, true, JSON.stringify(captured));
      assert.equal(captured.payload.contentId, contentId);
      assert.equal(
        captured.payload.image,
        Buffer.from(`${surface.surfaceId}:${paneId}`).toString("base64"),
      );
      assert.equal(captured.payload.revision, pushed.payload.revision);
    }

    assert.deepEqual(
      core.listSurfaceAdmissionAttempts().map((attempt) => attempt.outcome),
      ["succeeded", "succeeded", "succeeded"],
    );
  } finally {
    for (const socket of surfaceSockets) socket.close();
    lifecycle.close();
    await server.stop();
  }
});

test("pair admission requires the lockless protocol capability", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const response = await request(socket, "pair.request", {
      controllerInstanceId: "missing-capability-controller",
      controllerProductName: "OpenClaw",
      projectionCapacityBytes: 5 * 1024 * 1024,
      protocolFeatures: [],
      protocolVersion: 1,
      surfaceId: surface.surfaceId,
    });
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.error.code, "capability_mismatch");
    assert.match(response.error.message, /lockless-multi-controller/);
  } finally {
    socket.close();
    await server.stop();
  }
});

test("AC-SURF-02: complete surface close persists a tombstone before zero-live socket teardown and restores exact identity after restart", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const firstPort = nextPort++;
  const firstServer = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port: firstPort,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await firstServer.start();
  const lifecycle = await connect(
    `ws://127.0.0.1:${firstPort}${firstServer.wsPath}`,
  );
  const surfaceSession = await connect(
    `ws://127.0.0.1:${firstPort}${firstServer.wsPath}`,
  );
  const lifecyclePair = await pair(lifecycle, "tight-beam");
  const surfacePair = await pair(
    surfaceSession,
    "tight-beam",
    surface.surfaceId,
  );
  assert.equal(lifecyclePair.ok, true, JSON.stringify(lifecyclePair));
  assert.equal(surfacePair.ok, true, JSON.stringify(surfacePair));
  const listed = await request(lifecycle, "surfaces.list", {});
  const panes = await request(surfaceSession, "panes.list", {
    surfaceId: surface.surfaceId,
  });
  const anchorPaneId = panes.payload.panes[0].paneId;
  const split = await request(surfaceSession, "pane.split", {
    count: 2,
    direction: "horizontal",
    expectedTopologyRevision: panes.payload.topology.topologyRevision,
    paneId: anchorPaneId,
    surfaceId: surface.surfaceId,
  });
  assert.equal(split.ok, true, JSON.stringify(split));
  const nestedPaneId = split.payload.panes.find(
    (pane: { paneId: number }) => pane.paneId !== anchorPaneId,
  ).paneId;
  const content = await request(surfaceSession, "content.set", {
    content: { markdown: "# retained nested material" },
    contentId: "nested-retained-content",
    contentType: "markdown",
    paneId: nestedPaneId,
    surfaceId: surface.surfaceId,
  });
  assert.equal(content.ok, true, JSON.stringify(content));
  core.locklessAuthority.appendConsumable({
    payload: { value: "nested-unread" },
    recordClass: "tap",
    scopeId: locklessPaneScopeId(surface.surfaceId, nestedPaneId),
    scopeKind: "pane",
    triggerOperation: "test.surface-close",
  });
  const nestedClosed = await request(surfaceSession, "pane.close", {
    expectedTopologyRevision: split.payload.topologyRevision,
    paneId: nestedPaneId,
    surfaceId: surface.surfaceId,
  });
  assert.equal(nestedClosed.ok, true, JSON.stringify(nestedClosed));
  const closed = await request(surfaceSession, "surface.window.close", {
    expectedSurfaceSetRevision: listed.payload.surfaceSetRevision,
    expectedTopologyRevision: nestedClosed.payload.topologyRevision,
    surfaceId: surface.surfaceId,
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  lifecycle.close();
  surfaceSession.close();
  await firstServer.stop();

  const restarted = new SurfaceCore({
    persistentState: core.getPersistentState(),
  });
  assert.deepEqual(
    restarted.restorePersistedSurfaces("Surf Ace", {
      height: 800,
      scale: 2,
      width: 1200,
    }),
    [],
  );
  assert.equal(restarted.listSurfaces().length, 0);
  const retainedSurface = restarted.locklessAuthority
    .listTombstones("surface")[0]!;
  const retainedPayload = retainedSurface.payload as {
    paneTombstones: Array<{
      payload: { pane: { history: Array<{ contentId: string }> } };
      scopes: Record<string, { records: Array<{ payload: unknown }> }>;
      tombstoneId: string;
    }>;
  };
  assert.equal(
    retainedPayload.paneTombstones[0]?.tombstoneId,
    nestedClosed.payload.tombstoneId,
  );
  assert.equal(
    retainedPayload.paneTombstones[0]?.payload.pane.history.some(
      (entry) => entry.contentId === "nested-retained-content",
    ),
    true,
  );
  assert.equal(
    retainedPayload.paneTombstones[0]?.scopes[
      locklessPaneScopeId(surface.surfaceId, nestedPaneId)
    ]?.records.length,
    2,
  );
  const secondPort = nextPort++;
  const secondServer = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core: restarted,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port: secondPort,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await secondServer.start();
  const resumed = await connect(
    `ws://127.0.0.1:${secondPort}${secondServer.wsPath}`,
  );
  try {
    const admitted = await pair(resumed, "tight-beam");
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(admitted.payload.resumed, true);
    const empty = await request(resumed, "surfaces.list", {});
    assert.deepEqual(empty.payload.surfaces, []);
    const restored = await request(resumed, "surface.window.restore", {
      expectedSurfaceSetRevision: closed.payload.surfaceSetRevision,
      tombstoneId: closed.payload.tombstoneId,
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.payload.surfaceId, surface.surfaceId);
    assert.equal(
      restarted.locklessAuthority.listTombstones("pane")[0]?.tombstoneId,
      nestedClosed.payload.tombstoneId,
    );
  } finally {
    resumed.close();
    await secondServer.stop();
  }
});

test("AC-SURF-01: controller and local-user surface lifecycle share the persisted client authority seam", async () => {
  const core = new SurfaceCore();
  core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  let persistedRevision = -1;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      persistedRevision = core.locklessAuthority.surfaceSetRevision;
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const lifecycle = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(lifecycle, "lifecycle-controller")).ok, true);
    const initial = await request(lifecycle, "surfaces.list", {});
    const opened = await request(lifecycle, "surface.window.open", {
      expectedSurfaceSetRevision: initial.payload.surfaceSetRevision,
    });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.payload.surfaceSetRevision, initial.payload.surfaceSetRevision + 1);
    assert.equal(persistedRevision, opened.payload.surfaceSetRevision);

    const localOpened = await server.openSurfaceFromLocalUser();
    assert.equal(localOpened.surfaceSetRevision, opened.payload.surfaceSetRevision + 1);
    assert.equal(persistedRevision, localOpened.surfaceSetRevision);
    const localClosed = await server.closeSurfaceFromLocalUser(localOpened.surfaceId);
    assert.equal(localClosed.surfaceSetRevision, localOpened.surfaceSetRevision + 1);
    assert.equal(persistedRevision, localClosed.surfaceSetRevision);
    assert.equal(
      core.locklessAuthority.listTombstones("surface")
        .some((entry) => entry.tombstoneId === localClosed.tombstoneId),
      true,
    );
  } finally {
    lifecycle.close();
    await server.stop();
  }
});

test("AC-SURF-04: concurrent lifecycle requests serialize once and stale callers must recompute with a new request ID", async () => {
  const core = new SurfaceCore();
  core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const first = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const second = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(first, "lifecycle-first")).ok, true);
    assert.equal((await pair(second, "lifecycle-second")).ok, true);
    const initialRevision = core.locklessAuthority.surfaceSetRevision;
    const [left, right] = await Promise.all([
      request(first, "surface.window.open", {
        expectedSurfaceSetRevision: initialRevision,
      }, { id: "rq_surface_open_left" }),
      request(second, "surface.window.open", {
        expectedSurfaceSetRevision: initialRevision,
      }, { id: "rq_surface_open_right" }),
    ]);
    const winner = [left, right].find((response) => response.ok)!;
    const stale = [left, right].find((response) => !response.ok)!;
    assert.equal(stale.error.code, "stale_surface_set");
    assert.equal(core.listSurfaces().length, 2);
    const retrySocket = stale.id === "rq_surface_open_left" ? first : second;
    const retried = await request(retrySocket, "surface.window.open", {
      expectedSurfaceSetRevision: winner.payload.surfaceSetRevision,
    }, { id: "rq_surface_open_recomputed" });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(
      retried.payload.surfaceSetRevision,
      winner.payload.surfaceSetRevision + 1,
    );
    assert.equal(core.listSurfaces().length, 3);
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("copied Electron and extension roots cold-start the production lockless server and controller", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "surf-ace-copied-composition-"));
  const electronSourceRoot = path.join(root, "electron-source");
  const electronCopiedRoot = path.join(root, "electron-copy");
  const extensionSourceRoot = path.join(root, "extension-source");
  const extensionCopiedRoot = path.join(root, "extension-copy");
  const electronStateFile = "surf-ace-state.json";
  let electronWrites = Promise.resolve();
  const settleElectronWrites = async (): Promise<void> => await electronWrites;
  const createServer = (core: SurfaceCore, port: number, stateRoot: string) =>
    new SurfaceWsServer({
      capturePaneImage: async () => null,
      compositorSocketPath: null,
      core,
      endpointName: "Surf Ace",
      hostName: "localhost",
      persistLocklessState: async () => {
        const state = core.getPersistentState();
        electronWrites = electronWrites.then(async () => {
          await writePersistentStateFile(stateRoot, electronStateFile, state);
        });
        await electronWrites;
      },
      port,
      viewport: () => ({ height: 800, scale: 2, width: 1200 }),
    });
  try {
    await mkdir(extensionSourceRoot, { recursive: true });
    const sourceCore = new SurfaceCore({ clientIdentity: "electron-copied-root" });
    const sourceSurface = sourceCore.ensurePrimarySurface("Surf Ace", {
      height: 800,
      scale: 2,
      width: 1200,
    });
    const sourcePort = nextPort++;
    const sourceServer = createServer(sourceCore, sourcePort, electronSourceRoot);
    await writePersistentStateFile(electronSourceRoot, electronStateFile, sourceCore.getPersistentState());
    await sourceServer.start();
    const sourceController = new OpenClawLocklessController({
      discovery: new CopiedRootDiscovery(copiedRootEndpoint(sourcePort)),
      stateDir: extensionSourceRoot,
    });
    await sourceController.start();
    assert.equal((await sourceController.listScreens())[0]?.fingerprint, sourceSurface.surfaceId);
    await sourceController.stop();
    await sourceServer.stop();
    await settleElectronWrites();
    await writePersistentStateFile(electronSourceRoot, electronStateFile, sourceCore.getPersistentState());

    await cp(electronSourceRoot, electronCopiedRoot, { recursive: true });
    await cp(extensionSourceRoot, extensionCopiedRoot, { recursive: true });
    const loaded = await loadPersistentStateFile(electronCopiedRoot, electronStateFile);
    assert.equal(loaded.writeGuard, false);
    assert.ok(loaded.state);
    const copiedCore = new SurfaceCore({
      clientIdentity: "electron-copied-root",
      persistentState: loaded.state,
    });
    copiedCore.restorePersistedSurfaces("Surf Ace", {
      height: 800,
      scale: 2,
      width: 1200,
    });
    const copiedPort = nextPort++;
    const copiedServer = createServer(copiedCore, copiedPort, electronCopiedRoot);
    await copiedServer.start();
    const copiedController = new OpenClawLocklessController({
      discovery: new CopiedRootDiscovery(copiedRootEndpoint(copiedPort)),
      stateDir: extensionCopiedRoot,
    });
    await copiedController.start();
    try {
      const copiedScreens = await copiedController.listScreens();
      assert.equal(copiedScreens[0]?.fingerprint, sourceSurface.surfaceId);
      assert.ok(Object.values(copiedCore.locklessAuthority.exportState().controllers)
        .some((controller) => controller.status === "live"));
    } finally {
      await copiedController.stop();
      await copiedServer.stop();
      await settleElectronWrites();
    }
  } finally {
    await settleElectronWrites();
    await rm(root, { force: true, recursive: true });
  }
});

test("copied clean Electron, iPhone, and iPad product roots admit through unchanged production authority semantics", async (t) => {
  const products = [
    { clientIdentity: "surf-ace-electron", endpointName: "Surf Ace Electron", product: "Electron" },
    { clientIdentity: "clawline-iphone", endpointName: "Clawline iPhone", product: "iPhone" },
    { clientIdentity: "clawline-ipad", endpointName: "Clawline iPad", product: "iPad" },
  ] as const;
  for (const product of products) {
    await t.test(product.product, async () => {
      const root = await mkdtemp(path.join(tmpdir(), `surf-ace-${product.product.toLowerCase()}-copy-`));
      const sourceRoot = path.join(root, "source");
      const copiedRoot = path.join(root, "copy");
      const extensionRoot = path.join(root, "extension");
      const stateFile = "surf-ace-state.json";
      let writes = Promise.resolve();
      try {
        await mkdir(extensionRoot, { recursive: true });
        const sourceCore = new SurfaceCore({ clientIdentity: product.clientIdentity });
        const sourceSurface = sourceCore.ensurePrimarySurface(product.endpointName, {
          height: 800,
          scale: 2,
          width: 1200,
        });
        await writePersistentStateFile(sourceRoot, stateFile, sourceCore.getPersistentState());
        await cp(sourceRoot, copiedRoot, { recursive: true });
        const loaded = await loadPersistentStateFile(copiedRoot, stateFile);
        assert.equal(loaded.writeGuard, false);
        assert.ok(loaded.state);
        const core = new SurfaceCore({
          clientIdentity: product.clientIdentity,
          persistentState: loaded.state,
        });
        core.restorePersistedSurfaces(product.endpointName, {
          height: 800,
          scale: 2,
          width: 1200,
        });
        const port = nextPort++;
        const server = new SurfaceWsServer({
          capturePaneImage: async () => null,
          compositorSocketPath: null,
          core,
          endpointName: product.endpointName,
          hostName: "localhost",
          persistLocklessState: async () => {
            const state = core.getPersistentState();
            writes = writes.then(async () => {
              await writePersistentStateFile(copiedRoot, stateFile, state);
            });
            await writes;
          },
          port,
          viewport: () => ({ height: 800, scale: 2, width: 1200 }),
        });
        await server.start();
        const controller = new OpenClawLocklessController({
          discovery: new CopiedRootDiscovery({
            ...copiedRootEndpoint(port),
            endpointId: product.clientIdentity,
            instanceName: product.endpointName,
            name: product.endpointName,
          }),
          stateDir: extensionRoot,
        });
        await controller.start();
        try {
          assert.equal((await controller.listScreens())[0]?.fingerprint, sourceSurface.surfaceId);
        } finally {
          await controller.stop();
          await server.stop();
          await writes;
        }
      } finally {
        await writes;
        await rm(root, { force: true, recursive: true });
      }
    });
  }
});

// --- V3 s8E: operation coverage over a saturated terminal ledger ---

function seedFullTerminalLedger(core: SurfaceCore): number {
  for (
    let index = 1;
    index <= LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS;
    index++
  ) {
    const attempt = core.beginSurfaceAdmissionAttempt({
      controllerInstanceId: `seed_controller_${index}`,
      requestId: `rq_seed_${index}`,
      surfaceId: `sf_seed${String(index % 3)}aaaaaa`,
    });
    core.succeedSurfaceAdmissionAttempt(attempt.attemptSequence);
  }
  return core.listSurfaceAdmissionAttempts().length;
}

test("a saturated terminal ledger still admits push, capture, close and cleanup", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const seeded = seedFullTerminalLedger(core);
  assert.equal(seeded, LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS);

  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    // pairing itself is what the baseline refused forever once the ledger filled
    const paired = await pair(socket, "openclaw", surface.surfaceId);
    assert.equal(paired.ok, true, JSON.stringify(paired));
    assert(
      core.listSurfaceAdmissionAttempts().length <=
        LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
    );

    const panes = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const paneId = Number(panes.payload.topology.panes[0].paneId);

    // push
    const marker = "# saturated ledger marker";
    const pushed = await request(socket, "content.set", {
      content: { markdown: marker },
      contentId: "content-saturated",
      contentType: "markdown",
      friendlyChatName: "OpenClaw",
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(pushed.ok, true, JSON.stringify(pushed));

    // read-only capture proves the expected visible content, not just ok
    const captured = await request(socket, "snapshot.get", {
      includeVisibleText: true,
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    // visibleText is produced by the renderer, which this headless harness has
    // none of, so the capture is proven against the committed content identity
    // instead. Exact visible-text proof belongs to the live soak in s10.
    assert.equal(captured.payload.contentId, "content-saturated");
    assert.equal(captured.payload.revision > 0, true);

    // split then close, so pane close and cleanup close both run paired
    const split = await request(socket, "pane.split", {
      count: 2,
      direction: "horizontal",
      expectedTopologyRevision: (
        await request(socket, "panes.list", { surfaceId: surface.surfaceId })
      ).payload.topology.topologyRevision,
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(split.ok, true, JSON.stringify(split));
    const afterSplit = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const created = afterSplit.payload.topology.panes
      .map((pane: { paneId: number }) => Number(pane.paneId))
      .find((candidate: number) => candidate !== paneId);
    assert(created !== undefined);

    const closed = await request(socket, "pane.close", {
      expectedTopologyRevision: split.payload.topologyRevision,
      paneId: created,
      surfaceId: surface.surfaceId,
    });
    assert.equal(closed.ok, true, JSON.stringify(closed));

    // back to the original one-pane topology, bounds still held
    const finalPanes = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    assert.equal(finalPanes.payload.topology.panes.length, 1);
    assert(
      core.listSurfaceAdmissionAttempts().length <=
        LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
    );
  } finally {
    socket.close();
    await server.stop();
  }
});

test("cumulative content above 1 MiB keeps every individual push valid and the base policy unchanged", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  seedFullTerminalLedger(core);

  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const paired = await pair(socket, "openclaw", surface.surfaceId);
    assert.equal(paired.ok, true, JSON.stringify(paired));
    const panes = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const paneId = Number(panes.payload.topology.panes[0].paneId);

    const chunk = "y".repeat(64 * 1024);
    let cumulative = 0;
    let lastMarker = "";
    let lastContentId = "";
    for (let index = 0; cumulative <= 1024 * 1024; index++) {
      lastMarker = `# cumulative ${index} ${chunk}`;
      lastContentId = `content-cumulative-${index}`;
      const pushed = await request(socket, "content.set", {
        content: { markdown: lastMarker },
        contentId: `content-cumulative-${index}`,
        contentType: "markdown",
        friendlyChatName: "OpenClaw",
        paneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(pushed.ok, true, JSON.stringify(pushed));
      cumulative += lastMarker.length;
    }
    assert(cumulative > 1024 * 1024);

    // exact final content, after more than a megabyte of cumulative input
    const captured = await request(socket, "snapshot.get", {
      includeVisibleText: true,
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    assert.equal(captured.payload.contentId, lastContentId);
    assert.equal(captured.payload.revision > 0, true);
  } finally {
    socket.close();
    await server.stop();
  }
});

test("a saturated ledger persisted and restarted still pairs and serves content", async () => {
  const seed = new SurfaceCore();
  const surface = seed.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  seedFullTerminalLedger(seed);
  const persisted = seed.getPersistentState();

  // restart from the exact persisted form the baseline could not recover from
  const restored = new SurfaceCore({ persistentState: persisted });
  const restoredSurface = restored.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core: restored,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const paired = await pair(socket, "openclaw", restoredSurface.surfaceId);
    assert.equal(paired.ok, true, JSON.stringify(paired));
    const panes = await request(socket, "panes.list", {
      surfaceId: restoredSurface.surfaceId,
    });
    const paneId = Number(panes.payload.topology.panes[0].paneId);
    const marker = "# restored after saturation";
    const pushed = await request(socket, "content.set", {
      content: { markdown: marker },
      contentId: "content-restored",
      contentType: "markdown",
      friendlyChatName: "OpenClaw",
      paneId,
      surfaceId: restoredSurface.surfaceId,
    });
    assert.equal(pushed.ok, true, JSON.stringify(pushed));
    const captured = await request(socket, "snapshot.get", {
      includeVisibleText: true,
      paneId,
      surfaceId: restoredSurface.surfaceId,
    });
    assert.equal(captured.payload.contentId, "content-restored");
  } finally {
    socket.close();
    await server.stop();
  }
});
