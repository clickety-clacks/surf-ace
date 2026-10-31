import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestConsoleDiagnosticLimiter,
  guestConsoleDiagnosticFields,
  safeDiagnosticUrl,
  safeGuestConsoleText,
} from "../src/guest-console-diagnostics.js";

test("data URLs are summarized while guest error context stays readable", () => {
  const dataUrl = `data:text/html;base64,${"payload".repeat(4_000)}`;
  const fields = guestConsoleDiagnosticFields("surface-test", 18, {
    currentUrl: dataUrl,
    currentUrlLength: dataUrl.length,
    event: "browser_content_console_message",
    level: "3",
    lineNumber: 27,
    message: `Uncaught Error: failed to load ${dataUrl}`,
    paneId: 4,
    sourceId: dataUrl,
    targetId: "target-test",
    url: dataUrl,
    urlLength: dataUrl.length,
    webContentsId: 41,
  });

  const serialized = JSON.stringify(fields);
  assert.equal(fields.renderer_paneId, 4);
  assert.equal(fields.renderer_lineNumber, 27);
  assert.equal(fields.renderer_level, "3");
  assert.match(String(fields.renderer_message), /^Uncaught Error: failed to load data:\[omitted /);
  assert.match(String(fields.renderer_sourceId), /^data:\[omitted /);
  assert.equal(fields.renderer_currentUrlLength, dataUrl.length);
  assert.equal(fields.renderer_urlLength, dataUrl.length);
  assert.equal(fields.renderer_sourceIdLength, dataUrl.length);
  assert.equal(serialized.includes("payload"), false);
  assert.equal(serialized.includes(dataUrl), false);

  const summary = safeDiagnosticUrl(dataUrl);
  assert.equal(summary.scheme, "data");
  assert.equal(summary.length, dataUrl.length);
  assert.equal(summary.display.includes("payload"), false);
  assert.equal(
    safeGuestConsoleText(`Uncaught error from ${dataUrl}`),
    `Uncaught error from data:[omitted ${dataUrl.length} characters]`,
  );
});

test("renderer-provided URL summaries retain original lengths without restoring payload text", () => {
  const fields = guestConsoleDiagnosticFields("surface-test", 18, {
    currentUrl: "data:[omitted 48000 characters]",
    currentUrlLength: 48_000,
    level: "3",
    message: "failed to load data:[omitted 48000 characters]",
    paneId: 4,
    url: "data:[omitted 48000 characters]",
    urlLength: 48_000,
  });
  assert.equal(fields.renderer_currentUrlLength, 48_000);
  assert.equal(fields.renderer_urlLength, 48_000);
  assert.equal(fields.renderer_currentUrl, "data:[omitted 48000 characters]");
  assert.equal(JSON.stringify(fields).includes("payload"), false);
});

test("concise web URL details remain available for a guest error", () => {
  const fields = guestConsoleDiagnosticFields("surface-test", 18, {
    currentUrl: "https://example.test/page",
    level: "3",
    lineNumber: 12,
    message: "guest request failed",
    paneId: 4,
    sourceId: "https://example.test/app.js",
    url: "https://example.test/page",
    urlHost: "example.test",
    urlPort: "443",
    urlScheme: "https",
  });
  assert.equal(fields.renderer_urlHost, "example.test");
  assert.equal(fields.renderer_urlPort, "443");
  assert.equal(fields.renderer_urlScheme, "https");
  assert.equal(fields.renderer_paneId, 4);
  assert.equal(fields.renderer_sourceId, "https://example.test/app.js");
  assert.equal(fields.renderer_message, "guest request failed");
});

test("repeated guest errors are coalesced per pane and later records retain the latest detail", () => {
  const limiter = new GuestConsoleDiagnosticLimiter(1_000);
  const makeFields = (message: string, paneId = 4) => ({
    renderer_event: "browser_content_console_message",
    renderer_level: "3",
    renderer_message: message,
    renderer_lineNumber: 27,
    renderer_paneId: paneId,
    renderer_sourceId: "https://example.test/app.js",
    routed_surface_id: "surface-test",
    sender_id: 18,
  });
  const first = makeFields("first error");

  assert.deepEqual(limiter.record(first, 1_000), first);
  assert.equal(limiter.record(makeFields("repeated error"), 1_001), null);
  assert.equal(limiter.record(makeFields("latest error"), 1_002), null);

  const otherPane = makeFields("other pane error", 5);
  assert.deepEqual(limiter.record(otherPane, 1_003), otherPane);

  assert.deepEqual(
    limiter.record(makeFields("latest error"), 2_000),
    { ...makeFields("latest error"), renderer_suppressed_count: 2 },
  );
});

test("non-error guest console messages remain individually visible", () => {
  const limiter = new GuestConsoleDiagnosticLimiter(1_000);
  const info = {
    renderer_event: "browser_content_console_message",
    renderer_level: "1",
    renderer_message: "guest ready",
    renderer_paneId: 4,
    routed_surface_id: "surface-test",
    sender_id: 18,
  };
  assert.deepEqual(limiter.record(info, 1_000), info);
  assert.deepEqual(limiter.record(info, 1_001), info);
});
