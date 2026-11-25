import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  EXTERNAL_NEW_WINDOW_EVENT,
  externalNewWindowFrameScript,
  externalNewWindowRequestUrl,
  embeddedNewWindowAction,
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

function runFrameScript({ subframe = false, readyState = "complete" } = {}) {
  const handlers = new Map();
  const events = [];
  const opened = [];
  const microtasks = [];
  const userActivation = { isActive: false };
  const requestEventName = EXTERNAL_NEW_WINDOW_EVENT;
  const window = {
    addEventListener: (type, handler) => handlers.set(`window:${type}`, handler),
    dispatchEvent: (event) => events.push(event),
    removeEventListener: (type) => handlers.delete(`window:${type}`),
    open: (...args) => {
      opened.push(args);
      return "embedded-window";
    },
  };
  window.top = window;
  const document = {
    baseURI: "https://chat.example.test/messages/thread",
    readyState,
    addEventListener: (type, handler) => handlers.set(type, handler),
  };
  runInNewContext(externalNewWindowFrameScript(), {
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
    queueMicrotask: (callback) => microtasks.push(callback),
    Reflect,
    URL,
    window,
  });
  return {
    document,
    handlers,
    events,
    opened,
    requestEventName,
    userActivation,
    window,
    runMicrotasks: () => microtasks.splice(0).forEach((callback) => callback()),
  };
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

test("top-frame anchor routing waits until page load handlers have run while window.open is wrapped early", () => {
  const fixture = runFrameScript({ readyState: "loading" });
  assert.equal(fixture.handlers.has("window:click"), false);
  fixture.userActivation.isActive = true;
  assert.equal(fixture.window.open("https://example.test/early-script"), null);
  assert.equal(fixture.events[0].detail.url, "https://example.test/early-script");

  const installAfterLoad = fixture.handlers.get("window:load");
  assert.equal(typeof installAfterLoad, "function");
  installAfterLoad({ isTrusted: false });
  assert.equal(fixture.handlers.has("window:click"), false);
  installAfterLoad({ isTrusted: true });
  assert.equal(fixture.handlers.has("window:click"), false);
  fixture.runMicrotasks();
  assert.equal(fixture.handlers.has("window:click"), true);
});

test("frame fixture routes only active HTTP(S) new-window requests and leaves same-pane links alone", () => {
  const fixture = runFrameScript();
  let prevented = false;
  fixture.handlers.get("window:click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/path")),
    defaultPrevented: false,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, false);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.window.open("https://example.test/path"), "embedded-window");
  assert.deepEqual(fixture.events, []);

  fixture.userActivation.isActive = true;
  const canceledAnchor = {
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/canceled")),
    defaultPrevented: true,
    preventDefault: () => { throw new Error("already-canceled anchor should not be prevented again"); },
  };
  fixture.handlers.get("window:click")?.(canceledAnchor);
  assert.equal(fixture.events.length, 0);

  fixture.handlers.get("window:click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("../article?q=term#section")),
    defaultPrevented: false,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.events[0].type, fixture.requestEventName);
  assert.equal(fixture.events[0].detail.url, "https://chat.example.test/article?q=term#section");
  prevented = false;
  fixture.handlers.get("window:click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/same-pane", "_self")),
    defaultPrevented: false,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, false);
  assert.equal(fixture.window.open("https://example.test/scripted"), null);
  const canceledWithScript = {
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/canceled-shared")),
    defaultPrevented: true,
    preventDefault: () => { throw new Error("already-canceled anchor should not be prevented again"); },
  };
  fixture.window.open("https://example.test/canceled-shared");
  fixture.handlers.get("window:click")?.(canceledWithScript);
  fixture.window.open("https://example.test/shared");
  fixture.handlers.get("window:click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/shared")),
    defaultPrevented: false,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(fixture.window.open("https://example.test/same-pane", "_self"), "embedded-window");
  assert.equal(fixture.window.open("https://example.test/parent-pane", "_parent"), "embedded-window");
  assert.equal(fixture.window.open("https://example.test/named", "existing-frame"), "embedded-window");
  assert.equal(fixture.window.open("", "_blank"), "embedded-window");
  assert.equal(fixture.window.open(undefined, "_blank"), "embedded-window");
  assert.equal(fixture.window.open(null, "_blank"), "embedded-window");
  assert.equal(fixture.window.open("mailto:person@example.test"), "embedded-window");
  assert.equal(fixture.opened.length, 8);
  assert.equal(fixture.events.length, 5);
  assert.deepEqual(fixture.events.slice(1).map((event) => event.detail.url), [
    "https://example.test/scripted",
    "https://example.test/canceled-shared",
    "https://example.test/shared",
    "https://example.test/shared",
  ]);
});

test("subframes dispatch active HTTP(S) new-window requests locally without opening a popup", () => {
  const fixture = runFrameScript({ subframe: true });
  let prevented = false;
  fixture.handlers.get("window:click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/iframe")),
    defaultPrevented: false,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, false);
  assert.equal(fixture.opened.length, 0);

  fixture.userActivation.isActive = true;
  fixture.handlers.get("window:click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/iframe?q=1#part")),
    defaultPrevented: false,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(fixture.events[0].type, fixture.requestEventName);
  assert.equal(fixture.events[0].detail.url, "https://example.test/iframe?q=1#part");
  assert.equal(fixture.opened.length, 0);

  assert.equal(fixture.window.open("https://example.test/scripted"), null);
  assert.equal(fixture.events[1].type, fixture.requestEventName);
  assert.equal(fixture.events[1].detail.url, "https://example.test/scripted");
  assert.equal(fixture.window.open("https://example.test/named", "existing-frame"), "embedded-window");
  assert.equal(fixture.window.open("", "_blank"), "embedded-window");
  assert.equal(fixture.window.open(undefined, "_blank"), "embedded-window");
  assert.equal(fixture.window.open(null, "_blank"), "embedded-window");
  assert.equal(fixture.opened.length, 4);
});
