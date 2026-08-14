import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compositorNativePaneStatusSummary,
  compositorFailureMessage,
  isOverlayNativePaneLivenessFailure,
  nativePaneInstanceIdsForCompositor,
  nativePaneWindowGroupsFromCompositorStatus,
  nativePaneReleaseRequestForCompositor,
  overlayLivePaneAuthorityFromCompositorResponse,
  overlayLivePaneInstanceIdFromCompositorResponse,
  overlayRegionsClearRequestForCompositor,
  overlayRegionsSetRequestForCompositor,
  overlayRegionsWithLivePaneInstanceAuthority,
  overlayRequestForCompositor,
  requestForCompositor,
  resolveCompositorControlSocketPath,
  resolvedOverlayRegionsForCompositor,
  sendCompositorControl,
  type NativePaneMaterialization,
  validatePaneHandleOverlayAlignment,
  validateMaterializationAgainstCompositorStatus,
} from "../src/native-pane-bridge.js";

function materialization(
  overrides: Partial<NativePaneMaterialization> = {},
): NativePaneMaterialization {
  return {
    op: "native_pane.host",
    overlaySet: {
      coordinateSpace: "surface_logical",
      regions: [
        {
          captures: [],
          kind: "native_pane",
          paneId: 118 as never,
          paneInstanceId: "pl_118",
          rect: { height: 384, width: 512, x: 512, y: 0 },
          regionId: "118:target_top",
          zIndex: 1,
        },
      ],
      revision: 3 as never,
      surfaceId: "sf_test" as never,
      topologyEpoch: 2 as never,
      windowId: "a",
    },
    panes: [
      {
        binding_id: "118:target_top",
        content_id: "target_top",
        geometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: 3 as never,
          height: 384,
          paneInstanceId: "pl_118",
          surfaceEpoch: "sf_test:1",
          topologyEpoch: 2 as never,
          width: 512,
          x: 512,
          y: 0,
        },
        id: 118 as never,
        process: { args: ["top"], command: "foot" },
        revision: 3 as never,
        target: "terminal",
      },
    ],
    ...overrides,
  };
}

test("native pane bridge resolves only the explicit compositor socket env", () => {
  assert.equal(resolveCompositorControlSocketPath({}), null);
  assert.equal(
    resolveCompositorControlSocketPath({ SURF_ACE_COMPOSITOR_SOCKET: "/tmp/surf-ace.sock" }),
    "/tmp/surf-ace.sock",
  );
  assert.equal(
    resolveCompositorControlSocketPath({ SURF_ACE_COMPOSITOR: "1" }),
    null,
  );
});

test("native pane bridge serializes host and overlay requests from protocol materialization", () => {
  const input = materialization();

  assert.deepEqual(requestForCompositor(input), {
    panes: input.panes.map((pane) => ({
      ...pane,
      ...(pane.windowGroup?.launchIdentity.launchToken
        ? { launchToken: pane.windowGroup.launchIdentity.launchToken }
        : {}),
    })),
    type: "native_pane.host",
  });
  assert.deepEqual(overlayRequestForCompositor(input), {
    ...input.overlaySet,
    regions: [
      {
        ...input.overlaySet!.regions[0]!,
        kind: "other",
        paneInstanceId: "118:target_top",
      },
    ],
    type: "overlay_regions.set",
    updateReason: "initial",
  });
  assert.equal(overlayRequestForCompositor(materialization({ op: "native_pane.update" }))?.updateReason, "update");
  assert.equal(overlayRequestForCompositor(materialization({ overlaySet: undefined })), null);
});

test("native pane bridge names compositor panes as native materialized panes, not topology panes", () => {
  assert.deepEqual(
    compositorNativePaneStatusSummary({
      ok: true,
      status: {
        overlay_regions: 0,
        panes: [],
      },
    }),
    {
      nativeMaterializedPaneCount: 0,
      nativePaneWindowGroups: [],
      topologyPaneCount: null,
      topologyPaneSource: "surf_ace_pair_or_panes_list",
    },
  );
  assert.deepEqual(
    compositorNativePaneStatusSummary({
      ok: true,
      status: {
        panes: [{ id: "native-1" }, { id: "native-2" }],
      },
    }),
    {
      nativeMaterializedPaneCount: 2,
      nativePaneWindowGroups: [],
      topologyPaneCount: null,
      topologyPaneSource: "surf_ace_pair_or_panes_list",
    },
  );
});

test("native pane bridge extracts pane-local window group diagnostics from compositor status", () => {
  const response = {
    ok: true,
    status: {
      native_pane_window_groups: [
        {
          accepted_secondary_count: 2,
          clipping_status: "clipped",
          denied_reasons: ["foreign_launch_token"],
          denied_toplevel_count: 1,
          focused_window_id: "dialog-1",
          launch_token: "sf:7:target:3",
          members: [
            {
              bounds: { height: 200, width: 300, x: 0, y: 0 },
              clipped_to_pane: true,
              focused: false,
              id: "primary-1",
              lifecycle: "live",
              role: "primary",
            },
            {
              bounds: { height: 80, width: 120, x: 32, y: 40 },
              clipped_to_pane: true,
              focused: true,
              id: "dialog-1",
              lifecycle: "live",
              role: "dialog",
            },
          ],
          pane_id: "7",
          pane_instance_id: "pl_7",
          pane_local_bounds: { height: 200, width: 300, x: 0, y: 0 },
          primary_window_id: "primary-1",
        },
      ],
      panes: [{ id: "7" }],
    },
  };

  assert.deepEqual(nativePaneWindowGroupsFromCompositorStatus(response), [{
    acceptedSecondaryCount: 2,
    clippingStatus: "clipped",
    deniedReasons: ["foreign_launch_token"],
    deniedToplevelCount: 1,
    focusedWindowId: "dialog-1",
    launchToken: "sf:7:target:3",
    members: [
      {
        bounds: { height: 200, width: 300, x: 0, y: 0 },
        clippedToPane: true,
        focused: false,
        id: "primary-1",
        lifecycle: "live",
        role: "primary",
      },
      {
        bounds: { height: 80, width: 120, x: 32, y: 40 },
        clippedToPane: true,
        focused: true,
        id: "dialog-1",
        lifecycle: "live",
        role: "dialog",
      },
    ],
    paneId: "7",
    paneInstanceId: "pl_7",
    paneLocalBounds: { height: 200, width: 300, x: 0, y: 0 },
    primaryWindowId: "primary-1",
  }]);
  assert.equal(compositorNativePaneStatusSummary(response).nativePaneWindowGroups[0]?.acceptedSecondaryCount, 2);
  assert.equal(
    nativePaneWindowGroupsFromCompositorStatus({
      ...response,
      native_pane_window_groups: response.status.native_pane_window_groups,
      status: { panes: [{ id: "7" }] },
    })[0]?.paneId,
    "7",
  );
  assert.deepEqual(nativePaneWindowGroupsFromCompositorStatus({
    ok: true,
    status: {
      windowGroups: [{
        acceptedSecondaryCount: 1,
        clippingStatus: "clipped",
        deniedReasons: [],
        deniedToplevelCount: 0,
        focusedWindowId: 9002,
        launchToken: "sf:7:target:3",
        members: [{
          bounds: { height: 80, width: 120, x: 32, y: 40 },
          clippedToPane: true,
          focused: true,
          role: "dialog",
          windowId: 9002,
        }],
        paneId: 7,
        paneInstanceId: "pl_7",
        paneLocalBounds: { height: 200, width: 300, x: 0, y: 0 },
        primaryWindowId: 9001,
      }],
    },
  })[0], {
    acceptedSecondaryCount: 1,
    clippingStatus: "clipped",
    deniedReasons: [],
    deniedToplevelCount: 0,
    focusedWindowId: "9002",
    launchToken: "sf:7:target:3",
    members: [{
      bounds: { height: 80, width: 120, x: 32, y: 40 },
      clippedToPane: true,
      focused: true,
      id: "9002",
      lifecycle: "unknown",
      role: "dialog",
    }],
    paneId: "7",
    paneInstanceId: "pl_7",
    paneLocalBounds: { height: 200, width: 300, x: 0, y: 0 },
    primaryWindowId: "9001",
  });
});

test("native pane bridge derives native overlay rectangles from pane geometry", () => {
  const input = materialization({
    overlaySet: {
      ...materialization().overlaySet!,
      regions: [
        {
          ...materialization().overlaySet!.regions[0]!,
          paneInstanceId: "stale_lineage",
          rect: { height: 1, width: 1, x: 0, y: 0 },
        },
      ],
    },
  });

  assert.deepEqual(overlayRequestForCompositor(input), {
    ...input.overlaySet,
    regions: [
      {
        ...input.overlaySet!.regions[0]!,
        kind: "other",
        paneInstanceId: "118:target_top",
        rect: { height: 384, width: 512, x: 512, y: 0 },
      },
    ],
    type: "overlay_regions.set",
    updateReason: "initial",
  });
});

test("native pane bridge serializes renderer overlay region updates without coordinate rounding", () => {
  const request = overlayRegionsSetRequestForCompositor({
    regions: [
      {
        captures: ["pointer_hover"],
        kind: "pane_badge",
        paneId: "sf_test:118",
        paneInstanceId: "sf_test:118:target_top",
        rect: { height: 29.75, width: 102.5, x: 48.25, y: 18.5 },
        regionId: "surf-ace-pane-118-pane-indicator-0",
        zIndex: 15,
      },
    ],
    revision: 7,
    surfaceId: "sf_test",
    topologyEpoch: 4,
    updateReason: "layout",
    windowId: "window-a",
  });

  assert.deepEqual(request, {
    coordinateSpace: "surface_logical",
    regions: [
      {
        captures: ["pointer_hover"],
        kind: "pane_badge",
        paneId: "sf_test:118",
        paneInstanceId: "sf_test:118:target_top",
        rect: { height: 29.75, width: 102.5, x: 48.25, y: 18.5 },
        regionId: "surf-ace-pane-118-pane-indicator-0",
        zIndex: 15,
      },
    ],
    revision: 7,
    surfaceId: "sf_test",
    topologyEpoch: "4",
    type: "overlay_regions.set",
    updateReason: "layout",
    windowId: "window-a",
  });
});

test("native pane bridge validates deg90 full-height pane handle alignment", () => {
  const panes = [
    { id: "1", geometry: { coordinateSpace: "compositor_logical", height: 3840, width: 1080, x: 0, y: 0 } },
    { id: "2", geometry: { coordinateSpace: "compositor_logical", height: 3840, width: 1080, x: 1080, y: 0 } },
  ];
  const regions = [
    {
      captures: ["pointer_hover", "pointer_button", "pointer_axis"],
      kind: "pane_handle",
      paneId: "1",
      paneInstanceId: "1:target_portrait_btop",
      rect: { height: 48, width: 148, x: 466, y: 3743 },
      regionId: "surf-ace-pane-1-pane-handle-0",
      zIndex: 10,
    },
    {
      captures: ["pointer_hover", "pointer_button", "pointer_axis"],
      kind: "pane_handle",
      paneId: "2",
      paneInstanceId: "2:target_portrait_top",
      rect: { height: 48, width: 148, x: 1546, y: 3743 },
      regionId: "surf-ace-pane-2-pane-handle-0",
      zIndex: 10,
    },
  ] as const;

  assert.deepEqual(validatePaneHandleOverlayAlignment({ panes, regions: [...regions] }), []);
  assert.match(
    validatePaneHandleOverlayAlignment({
      panes,
      regions: [
        {
          ...regions[0],
          rect: { height: 48, width: 148, x: 1006, y: 1837 },
        },
      ],
    }).join("\n"),
    /not bottom-aligned/,
  );
});

test("native pane bridge preserves renderer-measured chrome rects and resolves live native identity", () => {
  const panes = [
    {
      geometry: { coordinateSpace: "compositor_logical", height: 3840, width: 1080, x: 0, y: 0 },
      id: "1",
      paneInstanceId: "1:target_portrait_btop",
    },
    {
      geometry: { coordinateSpace: "compositor_logical", height: 3840, width: 1080, x: 1080, y: 0 },
      id: "2",
      paneInstanceId: "2:target_portrait_top",
    },
  ] as const;
  const badRendererRegions = [
    {
      captures: ["pointer_hover", "pointer_button", "pointer_axis"],
      kind: "pane_handle",
      paneId: "1",
      paneInstanceId: "stale",
      rect: { height: 62, width: 170, x: 455, y: 3762 },
      regionId: "surf-ace-pane-1-pane-handle-0",
      zIndex: 10,
    },
    {
      captures: ["pointer_hover", "pointer_button", "pointer_axis"],
      kind: "history_back",
      paneId: "1",
      paneInstanceId: "stale",
      rect: { height: 48, width: 48, x: 461, y: 3768 },
      regionId: "surf-ace-pane-1-history-back-1",
      zIndex: 20,
    },
    {
      captures: ["pointer_hover", "pointer_button", "pointer_axis"],
      kind: "history_forward",
      paneId: "1",
      paneInstanceId: "stale",
      rect: { height: 48, width: 48, x: 511, y: 3768 },
      regionId: "surf-ace-pane-1-history-forward-2",
      zIndex: 20,
    },
    {
      captures: ["pointer_hover", "pointer_button", "pointer_axis"],
      kind: "annotation_control",
      paneId: "1",
      paneInstanceId: "stale",
      rect: { height: 48, width: 48, x: 561, y: 3768 },
      regionId: "surf-ace-pane-1-annotation-control-3",
      zIndex: 20,
    },
  ] as const;

  assert.deepEqual(resolvedOverlayRegionsForCompositor([...badRendererRegions], panes), [
    {
      ...badRendererRegions[0],
      paneInstanceId: "1:target_portrait_btop",
    },
    {
      ...badRendererRegions[1],
      paneInstanceId: "1:target_portrait_btop",
    },
    {
      ...badRendererRegions[2],
      paneInstanceId: "1:target_portrait_btop",
    },
    {
      ...badRendererRegions[3],
      paneInstanceId: "1:target_portrait_btop",
    },
  ]);
});

test("native pane bridge omits renderer overlay regions for non-native panes", () => {
  const panes = [
    {
      geometry: {
        coordinateSpace: "compositor_logical",
        geometryRevision: 1,
        height: 1920,
        paneInstanceId: "sf_test:1:target_top",
        surfaceEpoch: 1,
        topologyEpoch: 1,
        width: 2160,
        x: 0,
        y: 0,
      },
      id: "1",
      paneInstanceId: "1:target_top",
    },
  ] as const;
  const regions = [
    {
      captures: ["pointer_hover"],
      kind: "pane_badge",
      paneId: "1",
      paneInstanceId: "stale",
      rect: { height: 200, width: 200, x: 1900, y: 1700 },
      regionId: "surf-ace-pane-1-label",
      zIndex: 15,
    },
    {
      captures: ["pointer_hover"],
      kind: "pane_badge",
      paneId: "2",
      paneInstanceId: "browser-pane",
      rect: { height: 200, width: 200, x: 1900, y: 3600 },
      regionId: "surf-ace-pane-2-label",
      zIndex: 15,
    },
  ] as const;

  assert.deepEqual(resolvedOverlayRegionsForCompositor([...regions], panes), [
    {
      ...regions[0],
      paneInstanceId: "1:target_top",
    },
  ]);
});

test("native pane bridge indexes live compositor pane instances from materialization bindings", () => {
  assert.deepEqual(
    [...nativePaneInstanceIdsForCompositor(materialization({
      panes: [
        {
          binding_id: "1:target_btop",
          content_id: "target_btop",
          geometry: {
            coordinateSpace: "compositor_logical",
            geometryRevision: 1 as never,
            height: 100,
            paneInstanceId: "pl_btop",
            surfaceEpoch: "sf_test:1",
            topologyEpoch: 1 as never,
            width: 100,
            x: 0,
            y: 0,
          },
          id: "1",
          revision: 1 as never,
          target: "terminal",
        },
        {
          content_id: "target_top",
          geometry: {
            coordinateSpace: "compositor_logical",
            geometryRevision: 1 as never,
            height: 100,
            paneInstanceId: "pl_top",
            surfaceEpoch: "sf_test:1",
            topologyEpoch: 1 as never,
            width: 100,
            x: 100,
            y: 0,
          },
          id: "2",
          revision: 1 as never,
          target: "terminal",
        },
      ],
    })).entries()],
    [
      ["1", "1:target_btop"],
      ["2", "2:target_top"],
    ],
  );
});

test("native pane bridge serializes overlay region clears", () => {
  assert.deepEqual(overlayRegionsClearRequestForCompositor("sf_test", "window-a"), {
    surfaceId: "sf_test",
    type: "overlay_regions.clear",
    windowId: "window-a",
  });
  assert.deepEqual(overlayRegionsClearRequestForCompositor("sf_test"), {
    surfaceId: "sf_test",
    type: "overlay_regions.clear",
  });
});

test("native pane bridge serializes native pane releases", () => {
  assert.deepEqual(nativePaneReleaseRequestForCompositor([1, "2"]), {
    pane_ids: ["1", "2"],
    type: "native_pane.release",
  });
});

test("native pane bridge rejects untyped native pane geometry before compositor I/O", () => {
  const input = materialization();
  delete ((input.panes[0] as { geometry: Record<string, unknown> }).geometry).coordinateSpace;

  assert.throws(
    () => requestForCompositor(input),
    /geometry missing compositor_logical coordinate space/,
  );
});

test("native pane bridge validates compositor logical status bounds", () => {
  const request = requestForCompositor(materialization());

  assert.equal(
    validateMaterializationAgainstCompositorStatus(request, {
      ok: true,
      status: {
        logical_surface_height: 3840,
        logical_surface_width: 2160,
        pane_geometry_coordinate_space: "compositor_logical",
      },
    }),
    null,
  );
  assert.equal(
    validateMaterializationAgainstCompositorStatus(request, {
      ok: true,
      status: {
        pane_geometry_coordinate_space: "physical",
      },
    }),
    "compositor pane geometry coordinate space is physical, expected compositor_logical",
  );
  assert.match(
    validateMaterializationAgainstCompositorStatus(requestForCompositor(materialization({
      panes: [
        {
          ...materialization().panes[0]!,
          geometry: {
            ...materialization().panes[0]!.geometry,
            height: 2160,
            width: 3840,
            x: 0,
            y: 0,
          },
        },
      ],
    })), {
      ok: true,
      status: {
        logical_surface_height: 3840,
        logical_surface_width: 2160,
        pane_geometry_coordinate_space: "compositor_logical",
      },
    }),
    /outside compositor logical surface 2160x3840/,
  );
});

test("native pane bridge normalizes compositor failures", () => {
  assert.equal(compositorFailureMessage({ ok: true }), null);
  assert.equal(compositorFailureMessage({ message: "bad geometry", ok: false }), "bad geometry");
  assert.equal(
    compositorFailureMessage({ error: { message: "invalid pane" }, ok: false }),
    "invalid pane",
  );
  assert.equal(
    compositorFailureMessage({ error: { code: "invalid_state" }, ok: false }),
    "invalid_state",
  );
  assert.equal(
    compositorFailureMessage({ error: "stale overlay topology epoch: 1 != topology-2", ok: false }),
    "stale overlay topology epoch: 1 != topology-2",
  );
  assert.equal(compositorFailureMessage({ ok: false }), "compositor rejected materialization");
});

test("native pane bridge identifies transient overlay native-pane liveness failures", () => {
  assert.equal(
    isOverlayNativePaneLivenessFailure({
      error: "invalid overlay region: pane PaneId(\"1\") is not a live native-hosted pane",
      ok: false,
    }),
    true,
  );
  assert.equal(
    isOverlayNativePaneLivenessFailure({
      error: "stale overlay topology epoch: 1 != topology-2",
      ok: false,
    }),
    false,
  );
  assert.equal(isOverlayNativePaneLivenessFailure({ ok: true }), false);
});

test("native pane bridge extracts live overlay pane-instance authority from compositor failures", () => {
  const response = {
    error: "invalid overlay region: pane PaneId(\"1\") pane instance 'stale' does not match live pane instance '1:target_portrait_btop'",
    ok: false,
  };
  assert.equal(
    overlayLivePaneInstanceIdFromCompositorResponse(response),
    "1:target_portrait_btop",
  );
  assert.deepEqual(
    overlayLivePaneAuthorityFromCompositorResponse(response),
    { paneId: "1", paneInstanceId: "1:target_portrait_btop" },
  );
  assert.equal(overlayLivePaneInstanceIdFromCompositorResponse({ ok: true }), null);
});

test("native pane bridge scopes live pane-instance authority to the failed overlay region", () => {
  assert.deepEqual(
    overlayRegionsWithLivePaneInstanceAuthority([
      { paneId: "1", paneInstanceId: "stale-1" },
      { paneId: "2", paneInstanceId: "still-live-2" },
    ], {
      error: "invalid overlay region: pane PaneId(\"1\") pane instance 'stale-1' does not match live pane instance 'live-1'",
      ok: false,
    }),
    [
      { paneId: "1", paneInstanceId: "live-1" },
      { paneId: "2", paneInstanceId: "still-live-2" },
    ],
  );
});

test("native pane bridge sends newline-delimited compositor control requests", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-native-pane-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      received.push(JSON.parse(buffer.slice(0, newlineIndex)));
      socket.write(`${JSON.stringify({ ok: true, status: { regionCount: 12 } })}\n`);
      socket.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, resolve);
    server.once("error", reject);
  });
  try {
    const response = await sendCompositorControl(socketPath, overlayRequestForCompositor(materialization())!);
    assert.deepEqual(response, { ok: true, status: { regionCount: 12 } });
    assert.deepEqual(received, [overlayRequestForCompositor(materialization())]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});
