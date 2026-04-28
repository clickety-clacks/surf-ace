import assert from "node:assert/strict";
import test from "node:test";

import { surfaceWindowOptions } from "../src/window-options.js";

test("surface window is frameless when hosted by the compositor", () => {
  const options = surfaceWindowOptions({
    compositorSocketPath: "/tmp/surf-ace-compositor.sock",
    endpointName: "racter Surf Ace",
    viewport: { height: 3840, scale: 1, width: 2160 },
    windowLabel: "RACTER Overlay Verify",
  });

  assert.equal(options.frame, false);
  assert.equal(options.backgroundColor, "#00000000");
  assert.equal(options.show, true);
  assert.equal(options.transparent, true);
  assert.equal(options.useContentSize, true);
  assert.equal(options.height, 3840);
  assert.equal(options.width, 2160);
  assert.equal(options.title, "racter Surf Ace · RACTER Overlay Verify");
});

test("surface window keeps the platform frame outside compositor hosting", () => {
  const options = surfaceWindowOptions({
    compositorSocketPath: null,
    endpointName: "eezo Surf Ace",
    viewport: { height: 812, scale: 2, width: 375 },
  });

  assert.equal(options.frame, true);
  assert.equal(options.backgroundColor, "#0b1324");
  assert.equal(options.show, false);
  assert.equal(options.transparent, false);
  assert.equal(options.height, 812);
  assert.equal(options.width, 960);
  assert.equal(options.title, "eezo Surf Ace");
});
