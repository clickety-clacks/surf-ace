import assert from "node:assert/strict";
import test from "node:test";

import type { SurfAceRuntime } from "./surf-ace-runtime.js";
import { createSurfAceTools, surfAceToolNames } from "./surf-ace-tools.js";

function createStubRuntime(): SurfAceRuntime {
  return {
    annotateRemove: async () => ({
      displayId: "b4",
      fingerprint: "sf_1",
      notFoundStrokeIds: [],
      paneAddress: "b4",
      paneId: "4" as never,
      paneLabel: 4,
      remainingStrokeCount: 0,
      removedStrokeIds: [],
    }),
    capturePane: async () => ({
      capture: {
        browserUrl: null,
        bytesBase64: null,
        capturedAt: 1,
        contentType: null,
        dimensions: { height: 768, width: 1024 },
        displayId: "b4",
        failureReason: null,
        fingerprint: "sf_1",
        paneAddress: "b4",
        paneId: "4" as never,
        paneLabel: 4,
        scale: 2,
        topologyRevision: 2,
        visibleContentId: null,
        windowLabel: "b",
      },
    }),
    clear: async () => ({
      displayId: "b4",
      fingerprint: "sf_1",
      paneAddress: "b4",
      paneId: "4" as never,
      paneLabel: 4,
      revision: 1,
    }),
    closePane: async () => ({
      displayId: "b4",
      ok: true,
      paneAddress: "b4",
      paneId: "4" as never,
      paneLabel: 4,
    }),
    launchNativeApp: async () => ({
      contentId: null,
      displayId: "b4",
      fingerprint: "sf_1",
      paneAddress: "b4",
      paneId: "4" as never,
      paneLabel: 4,
      revision: 1,
      targetKind: "native_app",
    }),
    listScreens: async () => [{
      authority: { actionable: true, admitted: true, blockers: [], reason: null },
      connectionDiagnostics: {
        circuitOpen: false,
        circuitState: "closed",
        failureCount: 0,
        givenUp: false,
        openedAt: null,
        reason: null,
        reconnectAttempt: 0,
      },
      connectionState: "connected",
      endpointId: "endpoint-1",
      fingerprint: "sf_1",
      lastSeenAt: 1,
      name: "Studio",
      panes: [{
        activeContent: null,
        displayId: "b4",
        historySummary: { backCount: 0, forwardCount: 0, visibleContentId: null },
        name: null,
        paneAddress: "b4",
        paneId: "4" as never,
        paneLabel: 4,
        target: null,
        viewport: { height: 768, scale: 2, width: 1024 },
      }],
      pendingEvents: 0,
      topology: { paneId: "4" as never, type: "pane" },
      topologyRevision: 2,
      viewport: { height: 768, scale: 2, width: 1024 },
      windowLabel: "b",
    }],
    push: async () => ({
      contentId: "ct_1",
      displayId: "b4",
      fingerprint: "sf_1",
      paneAddress: "b4",
      paneId: "4" as never,
      paneLabel: 4,
      revision: 1,
    }),
    read: async () => ({
      browserUrl: null,
      contentSnapshot: null,
      displayId: "b4",
      fingerprint: "sf_1",
      frames: [],
      lastNavigation: null,
      liveDirtyStrokeIds: [],
      liveFrame: null,
      liveSeq: null,
      page: null,
      paneAddress: "b4",
      paneId: "4" as never,
      paneLabel: 4,
      playbackPosition: null,
      playbackState: null,
      readAt: 1,
      scrollPosition: null,
      selection: null,
      taps: [],
      windowLabel: "b",
    }),
    realizeTopologies: async () => ({ applied: [], ok: true }),
    realizeTopology: async () => ({
      createdPaneIds: [],
      destroyedPaneIds: [],
      destroyedPaneTombstones: [],
      ok: true,
      panes: [],
      preservedPaneIds: [],
      target: { root: true },
      topology: { paneId: "4" as never, type: "pane" },
      topologyRevision: 2,
    }),
    reattemptConnections: async () => ({ endpointProbes: [], surfaces: [] }),
    registerTarget: async (input) => ({
      idempotencyKey: input.idempotencyKey,
      status: "registered",
      targetEpoch: 1,
      targetId: "target-1",
    }),
    renamePane: async () => ({ ok: true }),
    restorePane: async () => ({ ok: true }),
    restoreTarget: async () => ({
      blockedReason: null,
      evidence: null,
      targetId: "target-1",
    }),
    snapshot: async () => ({
      displayId: "b4",
      fingerprint: "sf_1",
      paneAddress: "b4",
      paneId: "4" as never,
      paneLabel: 4,
      snapshot: null,
      windowLabel: "b",
    }),
    split: async () => [],
    start: async () => {},
    stop: async () => {},
    surfaceIntent: async () => ({ accepted: true }),
  };
}

test("official tool surface is current lockless only", () => {
  assert.deepEqual(surfAceToolNames, [
    "surf_ace_list",
    "surf_ace_push",
    "surf_ace_launch_native_app",
    "surf_ace_clear",
    "surf_ace_reattempt_connections",
    "surf_ace_split",
    "surf_ace_realize_topology",
    "surf_ace_realize_topologies",
    "surf_ace_close_pane",
    "surf_ace_rename_pane",
    "surf_ace_restore_pane",
    "surf_ace_surface_intent",
    "surf_ace_target_register",
    "surf_ace_target_apply",
    "surf_ace_read",
    "surf_ace_capture_pane",
    "surf_ace_annotations_remove",
  ]);
});

test("surf_ace_list filters the current admitted projection", async () => {
  const list = createSurfAceTools(createStubRuntime()).find((tool) => tool.name === "surf_ace_list");
  assert.ok(list);
  const result = await list.execute({ actionableOnly: true, paneId: "4" });
  assert.equal(result.length, 1);
  assert.equal(result[0].fingerprint, "sf_1");
  assert.deepEqual(result[0].panes.map((pane) => pane.paneAddress), ["b4"]);
});

test("target registration schema contains only current target material", () => {
  const tool = createSurfAceTools(createStubRuntime()).find((candidate) =>
    candidate.name === "surf_ace_target_register"
  );
  assert.ok(tool);
  assert.deepEqual(
    Object.keys(tool.inputSchema.properties as Record<string, unknown>).sort(),
    ["fingerprint", "idempotencyKey", "paneId"],
  );
});

test("window lifecycle operations inherit caller provenance", async () => {
  let requestedBy: string | undefined;
  const runtime: SurfAceRuntime = {
    ...createStubRuntime(),
    realizeTopologies: async (input) => {
      const operation = input.operations[0];
      requestedBy = operation && "action" in operation ? operation.requestedBy : undefined;
      return { applied: [], ok: true };
    },
  };
  const tool = createSurfAceTools(runtime).find((candidate) =>
    candidate.name === "surf_ace_realize_topologies"
  );
  assert.ok(tool);
  await tool.execute(
    { operations: [{ action: "openWindow", fingerprint: "sf_1" }] },
    { displayName: "Surface Agent" },
  );
  assert.equal(requestedBy, "Surface Agent");
});
