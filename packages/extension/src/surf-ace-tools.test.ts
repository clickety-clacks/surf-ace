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
    listScreens: async () => [],
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

test("CLU tool surface matches DESIGN.md exactly", () => {
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
    "surf_ace_read",
    "surf_ace_capture_pane",
    "surf_ace_annotations_remove",
  ]);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...surfAceToolNames],
  );

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
  assert.ok(Array.isArray(realizeProperties.target.anyOf));
  assert.deepEqual(
    realizeProperties.target.anyOf.map((variant: any) => Object.keys(variant.properties).sort()),
    [["root"], ["paneId"]],
  );
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
  assert.deepEqual(
    Object.keys(operationsSchema.items.properties).sort(),
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
  assert.deepEqual(operationsSchema.items.required, [
    "fingerprint",
    "target",
    "expectedTopologyRevision",
    "allowDestroyPaneIds",
    "desired",
  ]);
  assert.equal(operationsSchema.items.additionalProperties, false);

  const closePaneTool = tools.find((tool) => tool.name === "surf_ace_close_pane");
  assert.ok(closePaneTool);
  assert.deepEqual(
    Object.keys(closePaneTool.inputSchema.properties as Record<string, unknown>).sort(),
    ["fingerprint", "paneId"].sort(),
  );
  assert.deepEqual(closePaneTool.inputSchema.required, ["fingerprint", "paneId"]);
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
  });

  assert.deepEqual(captured, {
    content: "# Heading\n\n- one",
    contentType: "markdown",
    fingerprint: "sf_1",
    paneId: 1,
  });
  assert.equal(result.contentId, "ct_markdown");
});
