import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  EXTERNAL_NEW_WINDOW_FEATURE,
  externalNewWindowFrameScript,
  externalNewWindowRequestUrl,
  externalSubframeNewWindowRequestUrl,
  embeddedNewWindowAction,
  isMarkedExternalSubframeWindowOpen,
  isExternalNewWindowLink,
  resolveExternalHttpUrl,
} from "../src/external-new-window.ts";

class FixtureElement {
  constructor(link = null) {
    this.link = link;
  }

  closest(selector) {
    assert.equal(selector, "a[href]");
    return this.link;
  }
}

class FixtureAnchor extends FixtureElement {
  constructor(href, target = "_blank") {
    super();
    this.href = href;
    this.target = target;
  }
}

function runFrameScript({ subframe = false } = {}) {
  const handlers = new Map();
  const events = [];
  const opened = [];
  const userActivation = { isActive: false };
  const window = {
    dispatchEvent: (event) => events.push(event),
    open: (...args) => {
      opened.push(args);
      return "embedded-window";
    },
  };
  window.top = subframe ? {} : window;
  const document = {
    baseURI: "https://chat.example.test/messages/thread",
    addEventListener: (type, handler) => handlers.set(type, handler),
  };
  runInNewContext(externalNewWindowFrameScript, {
    CustomEvent: class FixtureCustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    document,
    Element: FixtureElement,
    HTMLAnchorElement: FixtureAnchor,
    navigator: { userActivation },
    queueMicrotask,
    Reflect,
    URL,
    window,
  });
  return { document, handlers, events, opened, userActivation, window };
}

test("HTTP(S) new-window links resolve relative paths with query and fragment intact", () => {
  assert.equal(
    resolveExternalHttpUrl("../article?q=term#section", "https://chat.example.test/messages/thread"),
    "https://chat.example.test/article?q=term#section",
  );
  assert.equal(isExternalNewWindowLink("_BLANK", "https://example.test/path"), true);
  assert.equal(isExternalNewWindowLink("_self", "https://example.test/path"), false);
});

test("only static HTML denies uncaptured embedded windows", () => {
  assert.equal(embeddedNewWindowAction(true), "deny");
  assert.equal(embeddedNewWindowAction(false), "allow");
  for (const url of [
    "mailto:person@example.test",
    "javascript:window.close()",
    "data:text/html,content",
    "custom-app://destination",
    "not a url",
  ]) {
    assert.equal(resolveExternalHttpUrl(url), null);
  }
});

test("source-frame requests require active activation and an HTTP(S) destination", () => {
  assert.equal(externalNewWindowRequestUrl({ url: "https://example.test/path?q=1#part" }, false), null);
  assert.equal(
    externalNewWindowRequestUrl({ url: "https://example.test/path?q=1#part" }, true),
    "https://example.test/path?q=1#part",
  );
  assert.equal(externalNewWindowRequestUrl({ url: "mailto:person@example.test" }, true), null);
  assert.equal(externalNewWindowRequestUrl({ url: "javascript:window.close()" }, true), null);
});

test("marked subframe requests require an active gesture and an HTTP(S) destination", () => {
  assert.equal(isMarkedExternalSubframeWindowOpen(EXTERNAL_NEW_WINDOW_FEATURE), true);
  assert.equal(isMarkedExternalSubframeWindowOpen("width=400,surfAceExternalNewWindow=1"), true);
  assert.equal(isMarkedExternalSubframeWindowOpen("width=400"), false);
  assert.equal(
    externalSubframeNewWindowRequestUrl("https://example.test/path?q=1#part", EXTERNAL_NEW_WINDOW_FEATURE, true, true),
    "https://example.test/path?q=1#part",
  );
  assert.equal(externalSubframeNewWindowRequestUrl("https://example.test/path", EXTERNAL_NEW_WINDOW_FEATURE, false, true), null);
  assert.equal(externalSubframeNewWindowRequestUrl("https://example.test/path", EXTERNAL_NEW_WINDOW_FEATURE, true, false), null);
  assert.equal(externalSubframeNewWindowRequestUrl("https://example.test/path", "width=400", true, true), null);
  assert.equal(externalSubframeNewWindowRequestUrl("mailto:person@example.test", EXTERNAL_NEW_WINDOW_FEATURE, true, true), null);
});

test("frame fixture routes only active HTTP(S) new-window requests and leaves same-pane links alone", () => {
  const fixture = runFrameScript();
  let prevented = false;
  fixture.handlers.get("click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/path")),
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, false);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.window.open("https://example.test/path"), "embedded-window");
  assert.deepEqual(fixture.events, []);

  fixture.userActivation.isActive = true;
  fixture.handlers.get("click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("../article?q=term#section")),
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.events[0].type, "surf-ace-external-new-window");
  assert.equal(fixture.events[0].detail.url, "https://chat.example.test/article?q=term#section");
  prevented = false;
  fixture.handlers.get("click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/same-pane", "_self")),
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, false);
  assert.equal(fixture.window.open("https://example.test/scripted"), null);
  assert.equal(fixture.window.open("https://example.test/same-pane", "_self"), "embedded-window");
  assert.equal(fixture.window.open("https://example.test/parent-pane", "_parent"), "embedded-window");
  assert.equal(fixture.window.open("mailto:person@example.test"), "embedded-window");
  assert.equal(fixture.opened.length, 4);
  assert.equal(fixture.events.length, 2);
  assert.equal(fixture.events[1].type, "surf-ace-external-new-window");
  assert.equal(fixture.events[1].detail.url, "https://example.test/scripted");
});

test("subframe requests reach the native popup gate with a marker", () => {
  const fixture = runFrameScript({ subframe: true });
  let prevented = false;
  fixture.handlers.get("click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/iframe")),
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, false);
  assert.equal(fixture.opened.length, 0);

  fixture.userActivation.isActive = true;
  fixture.handlers.get("click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/iframe?q=1#part")),
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.opened[0], [
    "https://example.test/iframe?q=1#part",
    "_blank",
    EXTERNAL_NEW_WINDOW_FEATURE,
  ]);

  assert.equal(fixture.window.open("https://example.test/scripted"), null);
  assert.deepEqual(fixture.opened[1], [
    "https://example.test/scripted",
    "_blank",
    EXTERNAL_NEW_WINDOW_FEATURE,
  ]);
});
