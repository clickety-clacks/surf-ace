import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { NativePaneMaterialization } from "../../protocol/src/index.js";
import {
  compositorFailureMessage,
  overlayRequestForCompositor,
  requestForCompositor,
  resolveCompositorControlSocketPath,
  sendCompositorControl,
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
        geometry: { coordinateSpace: "compositor_logical", height: 384, width: 512, x: 512, y: 0 },
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
    panes: input.panes,
    type: "native_pane.host",
  });
  assert.deepEqual(overlayRequestForCompositor(input), {
    ...input.overlaySet,
    type: "overlay_regions.set",
    updateReason: "initial",
  });
  assert.equal(overlayRequestForCompositor(materialization({ op: "native_pane.update" }))?.updateReason, "update");
  assert.equal(overlayRequestForCompositor(materialization({ overlaySet: undefined })), null);
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
          geometry: { coordinateSpace: "compositor_logical", height: 2160, width: 3840, x: 0, y: 0 },
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
  assert.equal(compositorFailureMessage({ ok: false }), "compositor rejected materialization");
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
