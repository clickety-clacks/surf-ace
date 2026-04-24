import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNativePaneHostPlan,
  createUnavailableNativePaneHostBridge,
  detectCompositorHostMode,
} from "../src/native-pane-bridge.js";

test("detectCompositorHostMode reads compositor host environment without requiring it", () => {
  assert.deepEqual(detectCompositorHostMode({}), {
    enabled: false,
    outputRotation: null,
    waylandDisplay: null,
  });
  assert.deepEqual(
    detectCompositorHostMode({
      SURF_ACE_COMPOSITOR: "1",
      SURF_ACE_OUTPUT_ROTATION: "ccw90",
      WAYLAND_DISPLAY: "surf-ace-0",
    }),
    {
      enabled: true,
      outputRotation: "ccw90",
      waylandDisplay: "surf-ace-0",
    },
  );
});

test("buildNativePaneHostPlan keeps Surf Ace pane identity and geometry with process intent", () => {
  const plan = buildNativePaneHostPlan({
    content: {
      process: {
        args: ["--login"],
        command: "zsh",
        cwd: "/tmp",
        env: { TERM: "xterm-256color" },
      },
      targetClass: "terminal",
    },
    contentId: "ct_native",
    geometry: { height: 300, width: 400, x: 10, y: 20 },
    paneId: 7,
    revision: 3,
    surfaceId: "sf_panel",
  });

  assert.deepEqual(plan, {
    contentId: "ct_native",
    geometry: { height: 300, width: 400, x: 10, y: 20 },
    paneId: 7,
    process: {
      args: ["--login"],
      command: "zsh",
      cwd: "/tmp",
      env: { TERM: "xterm-256color" },
    },
    revision: 3,
    surfaceId: "sf_panel",
    targetClass: "terminal",
  });
});

test("unavailable native pane bridge no-ops safely", async () => {
  const bridge = createUnavailableNativePaneHostBridge();
  assert.equal(bridge.available, false);
  assert.equal(await bridge.host({} as never), null);
  await assert.doesNotReject(() => bridge.release({} as never));
});
