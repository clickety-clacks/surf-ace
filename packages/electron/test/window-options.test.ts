import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { surfaceWindowLoadQuery, surfaceWindowOptions } from "../src/window-options.js";

test("surface window is frameless and visible when hosted by the compositor", () => {
  const options = surfaceWindowOptions({
    compositorSocketPath: "/tmp/surf-ace-compositor.sock",
    endpointName: "racter Surf Ace",
    viewport: { height: 3840, scale: 1, width: 2160 },
    windowLabel: "RACTER Overlay Verify",
  });

  assert.equal(options.frame, false);
  assert.equal(options.backgroundColor, "#00000000");
  assert.equal(options.hasShadow, false);
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
  assert.equal(options.hasShadow, true);
  assert.equal(options.show, false);
  assert.equal(options.transparent, false);
  assert.equal(options.height, 812);
  assert.equal(options.width, 960);
  assert.equal(options.title, "eezo Surf Ace");
});

test("surface window load query flags compositor hosting before first paint", () => {
  assert.deepEqual(surfaceWindowLoadQuery({
    compositorSocketPath: "/tmp/surf-ace-compositor.sock",
    surfaceId: "sf_alpha",
  }), {
    compositorHosted: "1",
    surfaceId: "sf_alpha",
  });

  assert.deepEqual(surfaceWindowLoadQuery({
    compositorSocketPath: null,
    surfaceId: "sf_normal",
  }), {
    surfaceId: "sf_normal",
  });
});

test("renderer enters compositor transparent mode before stylesheet paint", async () => {
  const indexHtml = await fs.readFile(new URL("../renderer/index.html", import.meta.url), "utf8");
  const stylesCss = await fs.readFile(new URL("../renderer/styles.css", import.meta.url), "utf8");
  const bootstrapScript = indexHtml.indexOf("document.documentElement.classList.add(\"compositor-hosted\")");
  const stylesheetLink = indexHtml.indexOf("<link rel=\"stylesheet\"");

  assert.notEqual(bootstrapScript, -1);
  assert.notEqual(stylesheetLink, -1);
  assert.ok(bootstrapScript < stylesheetLink);
  assert.match(stylesCss, /html\.compositor-hosted body,\s*body\.compositor-hosted\s*{\s*background: transparent;/);
  assert.match(stylesCss, /html\.compositor-hosted body \.pane-shell,\s*body\.compositor-hosted \.pane-shell\s*{\s*background: transparent;/);
});

test("compositor-hosted windows materialize with alpha bootstrap in one option path", async () => {
  const options = surfaceWindowOptions({
    compositorSocketPath: "/tmp/surf-ace-compositor.sock",
    endpointName: "racter Surf Ace",
    viewport: { height: 3840, scale: 1, width: 2160 },
  });
  const query = surfaceWindowLoadQuery({
    compositorSocketPath: "/tmp/surf-ace-compositor.sock",
    surfaceId: "sf_alpha",
  });
  const indexHtml = await fs.readFile(new URL("../renderer/index.html", import.meta.url), "utf8");
  const stylesheetLink = indexHtml.indexOf("<link rel=\"stylesheet\"");
  const bootstrapScript = indexHtml.indexOf("document.documentElement.classList.add(\"compositor-hosted\")");

  assert.equal(options.show, true);
  assert.equal(options.transparent, true);
  assert.equal(options.backgroundColor, "#00000000");
  assert.deepEqual(query, { compositorHosted: "1", surfaceId: "sf_alpha" });
  assert.ok(bootstrapScript !== -1 && stylesheetLink !== -1 && bootstrapScript < stylesheetLink);
});
