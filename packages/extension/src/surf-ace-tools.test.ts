import assert from "node:assert/strict";
import test from "node:test";

import type { SurfAceRuntime } from "./surf-ace-runtime.js";
import { createSurfAceTools, surfAceToolNames } from "./surf-ace-tools.js";

function createStubRuntime(): SurfAceRuntime {
  return {
    annotateRemove: async () => ({
      displayId: "1",
      fingerprint: "sf_1",
      notFoundStrokeIds: [],
      paneAddress: "1",
      paneId: 1,
      paneLabel: 1,
      remainingStrokeCount: 0,
      removedStrokeIds: [],
    }),
    capturePane: async () => ({
      capture: {
        browserUrl: null,
        bytesBase64: "iVBORw0KGgo=",
        capturedAt: Date.now(),
        contentType: "html",
        dimensions: { height: 768, width: 1024 },
        displayId: "1",
        failureReason: null,
        fingerprint: "sf_1",
        paneAddress: "1",
        paneId: 1,
        paneLabel: 1,
        scale: 2,
        topologyRevision: 1,
        visibleContentId: "ct_1" as never,
        windowLabel: "a",
      },
    }),
    clear: async () => ({
      displayId: "1",
      fingerprint: "sf_1",
      paneAddress: "1",
      paneId: 1,
      paneLabel: 1,
      revision: 1,
    }),
    closePane: async () => ({
      displayId: "1",
      ok: true,
      paneAddress: "1",
      paneId: 1,
      paneLabel: 1,
    }),
    launchNativeApp: async () => ({
      contentId: null,
      displayId: "1",
      fingerprint: "sf_1",
      paneAddress: "1",
      paneId: 1,
      paneLabel: 1,
      revision: 1,
      targetKind: "native_app",
    }),
    listScreens: async () => [
      {
        _debug: {
          autoRetryEnabled: true,
          endpointId: "endpoint-1",
          hasPairedInGatewaySession: true,
          localOwnership: null,
          ownershipRecovery: "active",
          providerAuthority: {
            actionable: true,
            admitted: true,
            blockers: [],
            reason: null,
          },
          providerAuthorityProjection: {
            activeTargetRecordCount: 0,
            authorityBlockedSurfaceIds: [],
            authorityBlockersBySurfaceId: {},
            disabled: false,
            liveSurfaceIds: ["sf_1"],
            nextRemotePaneId: 2,
            ownerStatus: "active",
            ownsRuntimeLease: true,
            persistedSelfOwnedSurfaceIds: [],
            persistedSurfaceIds: ["sf_1"],
            processId: process.pid,
            providerId: "pv_test",
            runtimeAppBindingBySurfaceId: {},
            runtimeScreenIds: ["sf_1"],
            started: true,
            surfaceTombstones: {},
            targetStateSurfaceIds: [],
            windowLabelSurfaceIds: ["sf_1"],
          },
          reconnectAttempt: 0,
          remoteOwnership: null,
          sessionId: "sa_1",
          unreachableFailures: 0,
          wsOpen: true,
        },
        authority: {
          actionable: true,
          admitted: true,
          blockers: [],
          reason: null,
        },
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
        fingerprint: "sf_1",
        lastSeenAt: Date.now(),
        name: "Surf Ace A",
        panes: [
          {
            activeContent: null,
            displayId: "b4",
            historySummary: [],
            name: null,
            paneAddress: "b4",
            paneId: 4,
            paneLabel: 4,
            target: null,
            viewport: { height: 768, scale: 2, width: 1024 },
          },
          {
            activeContent: null,
            displayId: "b9",
            historySummary: [],
            name: null,
            paneAddress: "b9",
            paneId: 9,
            paneLabel: 9,
            target: null,
            viewport: { height: 768, scale: 2, width: 1024 },
          },
        ],
        pendingEvents: 0,
        topology: {
          children: [
            { paneId: 4, type: "pane" },
            { paneId: 9, type: "pane" },
          ],
          direction: "vertical",
          type: "split",
        },
        topologyRevision: 2,
        viewport: { height: 768, scale: 2, width: 1024 },
        windowLabel: "b",
      },
    ],
    providerAuthorityDiagnostics: async () => ({
      activeTargetRecordCount: 0,
      authorityBlockedSurfaceIds: [],
      authorityBlockersBySurfaceId: {},
      disabled: false,
      liveSurfaceIds: [],
      nextRemotePaneId: 1,
      ownerStatus: "active",
      ownsRuntimeLease: true,
      persistedSelfOwnedSurfaceIds: [],
      persistedSurfaceIds: [],
      processId: process.pid,
      providerId: "pv_test",
      runtimeAppBindingBySurfaceId: {},
      runtimeScreenIds: [],
      started: true,
      surfaceTombstones: {},
      targetStateSurfaceIds: [],
      windowLabelSurfaceIds: [],
    }),
    push: async () => ({
      contentId: "ct_1",
      displayId: "1",
      fingerprint: "sf_1",
      paneAddress: "1",
      paneId: 1,
      paneLabel: 1,
      revision: 1,
    }),
    read: async () => ({
      browserUrl: null,
      contentSnapshot: null,
      displayId: "1",
      fingerprint: "sf_1",
      frames: [],
      lastNavigation: null,
      liveDirtyStrokeIds: [],
      liveFrame: null,
      liveSeq: null,
      overflowed: false,
      page: null,
      paneAddress: "1",
      paneId: 1,
      paneLabel: 1,
      playbackPosition: null,
      playbackState: null,
      readAt: Date.now(),
      scrollPosition: null,
      selection: null,
      taps: [],
      windowLabel: "a",
    }),
    reattemptConnections: async () => ({
      endpointProbes: [],
      surfaces: [],
    }),
    relinquish: async () => ({
      relinquished: true,
    }),
    realizeTopology: async () => ({
      createdPaneIds: [],
      destroyedPaneIds: [],
      ok: true,
      panes: [],
      preservedPaneIds: [],
      target: { root: true },
      topology: { paneId: "pn_1" as never, type: "pane" },
      topologyRevision: 1,
    }),
    realizeTopologies: async () => ({
      applied: [],
      ok: true,
    }),
    split: async () => [
      { displayId: "1", paneAddress: "1", paneId: 1, paneLabel: 1 },
      { displayId: "2", paneAddress: "2", paneId: 2, paneLabel: 2 },
    ],
    snapshot: async () => ({
      displayId: "1",
      fingerprint: "sf_1",
      paneAddress: "1",
      paneId: 1,
      paneLabel: 1,
      snapshot: null,
      windowLabel: "a",
    }),
    start: async () => {},
    stop: async () => {},
    subscribe: () => () => {},
  };
}

test("OpenClaw tool surface matches DESIGN.md exactly", () => {
  const tools = createSurfAceTools(createStubRuntime());

  assert.deepEqual(surfAceToolNames, [
    "surf_ace_list",
    "surf_ace_authority_diagnostics",
    "surf_ace_push",
    "surf_ace_launch_native_app",
    "surf_ace_clear",
    "surf_ace_relinquish",
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
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...surfAceToolNames],
  );

  const listTool = tools.find((tool) => tool.name === "surf_ace_list");
  assert.ok(listTool);
  assert.deepEqual(
    Object.keys(listTool.inputSchema.properties as Record<string, unknown>).sort(),
    ["actionableOnly", "fingerprint", "name", "paneAddress", "paneId", "windowLabel"].sort(),
  );
  assert.deepEqual(listTool.inputSchema.required, undefined);
  assert.equal(listTool.inputSchema.additionalProperties, false);

  const pushTool = tools.find((tool) => tool.name === "surf_ace_push");
  assert.ok(pushTool);
  assert.deepEqual(
    Object.keys(pushTool.inputSchema.properties as Record<string, unknown>).sort(),
    ["content", "contentType", "diagnostic", "fingerprint", "paneId", "sourcePath"].sort(),
  );
  assert.deepEqual(pushTool.inputSchema.required, ["fingerprint", "paneId", "contentType", "content"]);
  assert.equal(pushTool.inputSchema.additionalProperties, false);
  assert.deepEqual(
    (pushTool.inputSchema.properties as { contentType: { enum: string[] } }).contentType.enum,
    ["html", "image", "pdf", "terminal", "markdown", "video", "canvas", "browser_url"],
  );

  const captureTool = tools.find((tool) => tool.name === "surf_ace_capture_pane");
  assert.ok(captureTool);
  assert.deepEqual(
    Object.keys(captureTool.inputSchema.properties as Record<string, unknown>).sort(),
    ["fingerprint", "paneId"].sort(),
  );
  assert.deepEqual(captureTool.inputSchema.required, ["fingerprint", "paneId"]);
  assert.equal(captureTool.inputSchema.additionalProperties, false);

  const launchNativeAppTool = tools.find((tool) => tool.name === "surf_ace_launch_native_app");
  assert.ok(launchNativeAppTool);
  assert.deepEqual(
    Object.keys(launchNativeAppTool.inputSchema.properties as Record<string, unknown>).sort(),
    ["appId", "args", "confirmed", "cwd", "env", "fingerprint", "idempotencyKey", "launchMode", "paneId", "summary"].sort(),
  );
  assert.deepEqual(launchNativeAppTool.inputSchema.required, ["fingerprint", "paneId", "appId", "confirmed"]);
  assert.equal(launchNativeAppTool.inputSchema.additionalProperties, false);

  const splitTool = tools.find((tool) => tool.name === "surf_ace_split");
  assert.ok(splitTool);
  assert.deepEqual(
    Object.keys(splitTool.inputSchema.properties as Record<string, unknown>).sort(),
    ["count", "direction", "fingerprint", "paneId"].sort(),
  );
  assert.deepEqual(splitTool.inputSchema.required, ["fingerprint", "paneId", "count"]);
  assert.equal(splitTool.inputSchema.additionalProperties, false);

  const realizeTool = tools.find((tool) => tool.name === "surf_ace_realize_topology");
  assert.ok(realizeTool);
  assert.deepEqual(
    Object.keys(realizeTool.inputSchema.properties as Record<string, unknown>).sort(),
    ["allowDestroyPaneIds", "desired", "expectedTopologyRevision", "fingerprint", "target"].sort(),
  );
  assert.deepEqual(realizeTool.inputSchema.required, [
    "fingerprint",
    "target",
    "expectedTopologyRevision",
    "allowDestroyPaneIds",
    "desired",
  ]);
  assert.equal(realizeTool.inputSchema.additionalProperties, false);
  const realizeProperties = realizeTool.inputSchema.properties as Record<string, any>;
  assert.equal(realizeProperties.target.type, "object");
  assert.equal(realizeProperties.target.anyOf, undefined);
  assert.deepEqual(Object.keys(realizeProperties.target.properties).sort(), ["paneId", "root"]);
  assert.deepEqual(realizeProperties.target.required, ["root"]);
  assert.equal(realizeProperties.target.properties.root.type, "boolean");
  assert.equal(realizeProperties.target.properties.root.enum, undefined);
  assert.ok(Array.isArray(realizeProperties.desired.anyOf));
  const splitDesired = realizeProperties.desired.anyOf.find((variant: any) => variant.properties.children);
  assert.ok(splitDesired);
  assert.deepEqual(Object.keys(splitDesired.properties).sort(), ["children", "direction", "type", "weight"]);
  assert.ok(Array.isArray(splitDesired.properties.children.items.anyOf));
  const paneDesired = realizeProperties.desired.anyOf.find((variant: any) => variant.properties.paneId);
  assert.ok(paneDesired);
  assert.deepEqual(Object.keys(paneDesired.properties).sort(), ["name", "paneId", "type", "weight"]);

  const realizeBatchTool = tools.find((tool) => tool.name === "surf_ace_realize_topologies");
  assert.ok(realizeBatchTool);
  assert.deepEqual(Object.keys(realizeBatchTool.inputSchema.properties as Record<string, unknown>), ["operations"]);
  assert.deepEqual(realizeBatchTool.inputSchema.required, ["operations"]);
  assert.equal(realizeBatchTool.inputSchema.additionalProperties, false);
  const operationsSchema = (realizeBatchTool.inputSchema.properties as Record<string, any>).operations;
  assert.equal(operationsSchema.type, "array");
  assert.equal(operationsSchema.minItems, 1);
  assert.ok(Array.isArray(operationsSchema.items.anyOf));
  const topologyOperationSchema = operationsSchema.items.anyOf.find((variant: any) => variant.properties.desired);
  const lifecycleOperationSchema = operationsSchema.items.anyOf.find((variant: any) => variant.properties.action);
  assert.ok(topologyOperationSchema);
  assert.ok(lifecycleOperationSchema);
  assert.deepEqual(
    Object.keys(topologyOperationSchema.properties).sort(),
    [
      "allowDestroyPaneIds",
      "desired",
      "expectedTopologyRevision",
      "fingerprint",
      "operationId",
      "target",
      "windowLabel",
    ].sort(),
  );
  assert.deepEqual(topologyOperationSchema.required, [
    "fingerprint",
    "target",
    "expectedTopologyRevision",
    "allowDestroyPaneIds",
    "desired",
  ]);
  assert.equal(topologyOperationSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(lifecycleOperationSchema.properties).sort(),
    ["action", "fingerprint", "operationId", "requestedBy", "windowLabel"].sort(),
  );
  assert.deepEqual(lifecycleOperationSchema.required, ["fingerprint", "action"]);
  assert.deepEqual(lifecycleOperationSchema.properties.action.enum, ["openWindow", "closeWindow"]);
  assert.equal(lifecycleOperationSchema.additionalProperties, false);

  const closePaneTool = tools.find((tool) => tool.name === "surf_ace_close_pane");
  assert.ok(closePaneTool);
  assert.deepEqual(
    Object.keys(closePaneTool.inputSchema.properties as Record<string, unknown>).sort(),
    ["expectedTopologyRevision", "fingerprint", "paneId"].sort(),
  );
  assert.deepEqual(closePaneTool.inputSchema.required, [
    "fingerprint",
    "paneId",
    "expectedTopologyRevision",
  ]);
  assert.equal(closePaneTool.inputSchema.additionalProperties, false);

  const relinquishTool = tools.find((tool) => tool.name === "surf_ace_relinquish");
  assert.ok(relinquishTool);
  assert.deepEqual(
    Object.keys(relinquishTool.inputSchema.properties as Record<string, unknown>).sort(),
    ["fingerprint"].sort(),
  );
  assert.deepEqual(relinquishTool.inputSchema.required, ["fingerprint"]);
  assert.equal(relinquishTool.inputSchema.additionalProperties, false);

  const reattemptTool = tools.find((tool) => tool.name === "surf_ace_reattempt_connections");
  assert.ok(reattemptTool);
  assert.deepEqual(
    Object.keys(reattemptTool.inputSchema.properties as Record<string, unknown>).sort(),
    ["fingerprint"].sort(),
  );
  assert.deepEqual(reattemptTool.inputSchema.required, undefined);
  assert.equal(reattemptTool.inputSchema.additionalProperties, false);

});

test("surf_ace_realize_topologies forwards caller provenance for window lifecycle diagnostics", async () => {
  let observedRequestedBy: string | undefined;
  const runtime = {
    ...createStubRuntime(),
    realizeTopologies: async (input) => {
      const operation = input.operations[0];
      if (operation && "action" in operation) {
        observedRequestedBy = operation.requestedBy;
      }
      return {
        applied: [],
        ok: true,
      };
    },
  } satisfies SurfAceRuntime;
  const tool = createSurfAceTools(runtime).find((candidate) => candidate.name === "surf_ace_realize_topologies");
  assert.ok(tool);

  await tool.execute({
    operations: [{ action: "openWindow", fingerprint: "sf_1" }],
  }, { displayName: "Surface Agent" });

  assert.equal(observedRequestedBy, "Surface Agent");
});

test("surf_ace_list returns compact actionable surfaces and keeps authority projection diagnostic-only", async () => {
  const tools = createSurfAceTools(createStubRuntime());
  const listTool = tools.find((tool) => tool.name === "surf_ace_list");
  const diagnosticsTool = tools.find((tool) => tool.name === "surf_ace_authority_diagnostics");

  assert.ok(listTool);
  assert.ok(diagnosticsTool);

  const listResult = await listTool.execute({});
  const diagnosticsResult = await diagnosticsTool.execute({});
  const listJson = JSON.stringify(listResult);
  const diagnosticsJson = JSON.stringify(diagnosticsResult);

  assert.equal(Array.isArray(listResult), true);
  assert.deepEqual(Object.keys(listResult[0] ?? {}).sort(), [
    "authority",
    "connectionDiagnostics",
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
  ]);
  assert.equal(listResult[0]?.panes.some((pane) => pane.displayId === "b4" && pane.paneId === 4), true);
  assert.equal(listResult[0]?.panes.some((pane) => pane.displayId === "b9" && pane.paneId === 9), true);
  assert.equal("_debug" in listResult[0], false);
  assert.equal(listJson.includes("providerAuthorityProjection"), false);
  assert.equal(diagnosticsJson.includes("providerId"), true);
});

test("surf_ace_list supports bounded official fleet selection by surface and pane", async () => {
  const largeDebug = {
    autoRetryEnabled: true,
    endpointId: "endpoint-large",
    hasPairedInGatewaySession: true,
    localOwnership: null,
    ownershipRecovery: "active" as const,
    providerAuthority: {
      actionable: true,
      admitted: true,
      blockers: [],
      reason: null,
    },
    providerAuthorityProjection: {
      providerId: "pv_large",
      repeatedDiagnostics: "x".repeat(40_000),
    },
    reconnectAttempt: 0,
    remoteOwnership: null,
    sessionId: "sa_large",
    unreachableFailures: 0,
    wsOpen: true,
  };
  const runtime = {
    ...createStubRuntime(),
    listScreens: async () => [
      {
        ...(await createStubRuntime().listScreens())[0],
        _debug: {
          ...largeDebug,
          endpointId: "Cyberbrain.local:19001/ws#vision",
          localOwnership: {
            acceptedAt: Date.now(),
            endpointHost: "Cyberbrain.local",
            endpointId: "Cyberbrain.local:19001/ws#vision",
            endpointName: "Surf Ace - Apple Vision Pro",
            endpointPort: 19001,
            providerId: "pv_large",
            sessionId: "sa_large",
            source: "pair.response",
            surfaceId: "sf_cyberbrain",
          },
        },
        fingerprint: "sf_cyberbrain",
        name: "Surf Ace - Apple Vision Pro",
        panes: [
          {
            activeContent: null,
            displayId: "a1",
            historySummary: [],
            name: null,
            paneAddress: "a1",
            paneId: 1,
            paneLabel: 1,
            target: null,
            viewport: { height: 768, scale: 2, width: 1024 },
          },
        ],
        windowLabel: "a",
      },
      {
        ...(await createStubRuntime().listScreens())[0],
        _debug: largeDebug,
        fingerprint: "sf_workstation_a",
        name: "workstation-a",
        panes: [
          {
            activeContent: null,
            displayId: "b4",
            historySummary: [],
            name: null,
            paneAddress: "b4",
            paneId: 4,
            paneLabel: 4,
            target: null,
            viewport: { height: 768, scale: 2, width: 1024 },
          },
          {
            activeContent: null,
            displayId: "b9",
            historySummary: [],
            name: null,
            paneAddress: "b9",
            paneId: 9,
            paneLabel: 9,
            target: null,
            viewport: { height: 768, scale: 2, width: 1024 },
          },
        ],
        windowLabel: "b",
      },
    ],
  } as SurfAceRuntime;
  const listTool = createSurfAceTools(runtime).find((tool) => tool.name === "surf_ace_list");
  assert.ok(listTool);

  const workstationA = await listTool.execute({ actionableOnly: true, name: "workstation-a" });
  assert.deepEqual(workstationA.map((screen) => screen.fingerprint), ["sf_workstation_a"]);
  assert.equal(workstationA[0]?.panes.some((pane) => pane.displayId === "b4" && pane.paneId === 4), true);
  assert.equal(workstationA[0]?.panes.some((pane) => pane.displayId === "b9" && pane.paneId === 9), true);
  assert.equal(JSON.stringify(workstationA).includes("providerAuthorityProjection"), false);

  const cyberbrain = await listTool.execute({ actionableOnly: true, name: "Cyberbrain" });
  assert.deepEqual(cyberbrain.map((screen) => screen.fingerprint), ["sf_cyberbrain"]);
  assert.equal(cyberbrain[0]?.panes[0]?.displayId, "a1");
  assert.equal(cyberbrain[0]?.name, "Surf Ace - Apple Vision Pro");

  const paneB9 = await listTool.execute({ paneAddress: "b9" });
  assert.deepEqual(paneB9.map((screen) => screen.fingerprint), ["sf_workstation_a"]);
  assert.deepEqual(paneB9[0]?.panes.map((pane) => pane.displayId), ["b9"]);
  assert.ok(JSON.stringify(paneB9).length < 16_000);

  const paneIdB4 = await listTool.execute({ paneId: "4" });
  assert.deepEqual(paneIdB4.map((screen) => screen.fingerprint), ["sf_workstation_a"]);
  assert.deepEqual(paneIdB4[0]?.panes.map((pane) => pane.displayId), ["b4"]);
});

test("surf_ace_push forwards markdown content through the first-class push path", async () => {
  let captured: unknown;
  const runtime = {
    ...createStubRuntime(),
    push: async (args: unknown) => {
      captured = args;
      return {
        contentId: "ct_markdown",
        fingerprint: "sf_1",
        paneId: 1,
        revision: 1,
      };
    },
  } as SurfAceRuntime;
  const pushTool = createSurfAceTools(runtime).find((tool) => tool.name === "surf_ace_push");

  assert.ok(pushTool);
  const result = await pushTool.execute({
    content: "# Heading\n\n- one",
    contentType: "markdown",
    fingerprint: "sf_1",
    paneId: 1,
    sourcePath: "/tmp/notes.md",
  });

  assert.deepEqual(captured, {
    content: "# Heading\n\n- one",
    contentType: "markdown",
    fingerprint: "sf_1",
    paneId: 1,
    sourcePath: "/tmp/notes.md",
  });
  assert.equal(result.contentId, "ct_markdown");
});
