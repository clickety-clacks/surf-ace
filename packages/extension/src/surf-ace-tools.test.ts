import assert from "node:assert/strict";
import test from "node:test";

import type { SurfAceRuntime } from "./surf-ace-runtime.js";
import { createSurfAceTools, surfAceToolNames } from "./surf-ace-tools.js";

function createStubRuntime(): SurfAceRuntime {
  return {
    annotateRemove: async () => ({
      fingerprint: "sf_1",
      notFoundStrokeIds: [],
      paneId: 1,
      remainingStrokeCount: 0,
      removedStrokeIds: [],
    }),
    clear: async () => ({
      fingerprint: "sf_1",
      paneId: 1,
      revision: 1,
    }),
    closePane: async () => ({
      ok: true,
    }),
    listScreens: async () => [],
    push: async () => ({
      contentId: "ct_1",
      fingerprint: "sf_1",
      paneId: 1,
      revision: 1,
    }),
    read: async () => ({
      fingerprint: "sf_1",
      frames: [],
      lastNavigation: null,
      liveDirtyStrokeIds: [],
      liveFrame: null,
      liveSeq: null,
      overflowed: false,
      page: null,
      paneId: 1,
      playbackPosition: null,
      playbackState: null,
      readAt: Date.now(),
      scrollPosition: null,
      selection: null,
      taps: [],
    }),
    relinquish: async () => ({
      relinquished: true,
    }),
    split: async () => [{ paneId: 1 }, { paneId: 2 }],
    snapshot: async () => ({
      fingerprint: "sf_1",
      paneId: 1,
      snapshot: null,
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
    "surf_ace_push",
    "surf_ace_clear",
    "surf_ace_relinquish",
    "surf_ace_split",
    "surf_ace_close_pane",
    "surf_ace_read",
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
    ["content", "contentType", "fingerprint", "paneId"].sort(),
  );
  assert.deepEqual(pushTool.inputSchema.required, ["fingerprint", "paneId", "contentType", "content"]);
  assert.equal(pushTool.inputSchema.additionalProperties, false);

  const splitTool = tools.find((tool) => tool.name === "surf_ace_split");
  assert.ok(splitTool);
  assert.deepEqual(
    Object.keys(splitTool.inputSchema.properties as Record<string, unknown>).sort(),
    ["count", "direction", "fingerprint", "paneId"].sort(),
  );
  assert.deepEqual(splitTool.inputSchema.required, ["fingerprint", "paneId", "count", "direction"]);
  assert.equal(splitTool.inputSchema.additionalProperties, false);

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
});
