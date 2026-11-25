import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import {
  EXTERNAL_NEW_WINDOW_EVENT,
  EXTERNAL_NEW_WINDOW_FEATURE,
  appendExternalNewWindowFeature,
  createExternalNewWindowRequestBridge,
  externalNewWindowFrameScript,
  externalNewWindowRequestUrl,
  embeddedNewWindowAction,
  hasExternalNewWindowFeature,
  hasPendingExternalNewWindowRequest,
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
    this.hasHref = true;
  }

  hasAttribute(name) {
    return name === "href" && this.hasHref;
  }
}

function runFrameScript({ subframe = false, readyState = "complete", openResults = [], consumeActivationOnNull = false } = {}) {
  const handlers = new Map();
  const listenerOptions = new Map();
  const events = [];
  const opened = [];
  const tasks = [];
  const results = [...openResults];
  const userActivation = { isActive: false };
  const requestEventName = EXTERNAL_NEW_WINDOW_EVENT;
  const externalRequests = [];
  const routeRequest = createExternalNewWindowRequestBridge((url) => externalRequests.push(url));
  const window = {
    addEventListener: (type, handler, options) => {
      handlers.set(`window:${type}`, handler);
      listenerOptions.set(`window:${type}`, options);
    },
    dispatchEvent: (event) => {
      events.push(event);
      routeRequest(event.detail, userActivation.isActive);
    },
    removeEventListener: (type) => handlers.delete(`window:${type}`),
    open: (...args) => {
      opened.push(args);
      const result = results.length > 0 ? results.shift() : "embedded-window";
      if (consumeActivationOnNull && result === null) userActivation.isActive = false;
      return result;
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
    Event: FixtureClickEvent,
    HTMLAnchorElement: FixtureAnchor,
    navigator: { userActivation },
    Reflect,
    setTimeout: (callback) => tasks.push(callback),
    URL,
    window,
  });
  return {
    document,
    handlers,
    listenerOptions,
    events,
    externalRequests,
    opened,
    requestEventName,
    userActivation,
    window,
    runTasks: () => tasks.splice(0).forEach((callback) => callback()),
  };
}

class FixtureClickEvent {
  constructor(anchor, defaultPrevented = false) {
    this.isTrusted = true;
    this.target = new FixtureElement(anchor);
    this._defaultPrevented = defaultPrevented;
  }

  get defaultPrevented() {
    return this._defaultPrevented;
  }

  preventDefault() {
    this._defaultPrevented = true;
  }
}

function clickEvent(anchor, { defaultPrevented = false } = {}) {
  return new FixtureClickEvent(anchor, defaultPrevented);
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

test("external request bridge validates activation at prepare and completes after native popup denial", () => {
  const opened = [];
  const route = createExternalNewWindowRequestBridge((url) => opened.push(url));
  const request = { phase: "prepare", requestId: 1, url: "https://example.test/named" };

  route(request, false);
  route({ phase: "complete", requestId: 1 }, false);
  assert.deepEqual(opened, []);

  route(request, true);
  route({ phase: "cancel", requestId: 1 }, false);
  route({ phase: "complete", requestId: 1 }, false);
  assert.deepEqual(opened, []);

  route({ ...request, requestId: 2 }, true);
  route({ phase: "complete", requestId: 2 }, false);
  assert.deepEqual(opened, ["https://example.test/named"]);
});

test("external request bridge mirrors prepare, cancel, and complete phases", () => {
  const opened = [];
  const phases = [];
  const route = createExternalNewWindowRequestBridge(
    (url) => opened.push(url),
    (phase, requestId, url) => {
      phases.push({ phase, requestId, url });
      return true;
    },
  );

  route({ phase: "prepare", requestId: 1, url: "https://example.test/canceled" }, true);
  route({ phase: "cancel", requestId: 1 }, false);
  route({ phase: "complete", requestId: 1 }, false);
  route({ phase: "prepare", requestId: 2, url: "https://example.test/completed" }, true);
  route({ phase: "complete", requestId: 2 }, false);

  assert.deepEqual(phases, [
    { phase: "prepare", requestId: 1, url: "https://example.test/canceled" },
    { phase: "cancel", requestId: 1, url: "https://example.test/canceled" },
    { phase: "prepare", requestId: 2, url: "https://example.test/completed" },
    { phase: "complete", requestId: 2, url: "https://example.test/completed" },
  ]);
  assert.deepEqual(opened, ["https://example.test/completed"]);
});

test("abandoned external requests are canceled after the completion task", async () => {
  const opened = [];
  const phases = [];
  const route = createExternalNewWindowRequestBridge(
    (url) => opened.push(url),
    (phase, requestId) => { phases.push([phase, requestId]); return true; },
  );
  route({ phase: "prepare", requestId: 1, url: "https://example.test/abandoned" }, true);
  route({ phase: "prepare", requestId: 2, url: "https://example.test/anchor" }, true);
  setTimeout(() => route({ phase: "complete", requestId: 2 }, false));
  await new Promise((resolve) => setTimeout(() => setTimeout(resolve)));
  route({ phase: "complete", requestId: 1 }, false);
  assert.deepEqual(opened, ["https://example.test/anchor"]);
  assert.deepEqual(phases, [["prepare", 1], ["prepare", 2], ["complete", 2], ["cancel", 1]]);
});

test("anchor routing is installed before load and captures clicks before page handlers", () => {
  const fixture = runFrameScript({ readyState: "loading" });
  const handler = fixture.handlers.get("window:click");
  assert.equal(typeof handler, "function");
  assert.equal(fixture.listenerOptions.get("window:click"), true);
  fixture.userActivation.isActive = true;
  assert.equal(fixture.window.open("https://example.test/early-script"), null);
  assert.equal(fixture.externalRequests[0], "https://example.test/early-script");
});

test("anchor routing leaves cancellation to page handlers and does not deduplicate URLs", () => {
  const fixture = runFrameScript();
  const handler = fixture.handlers.get("window:click");
  handler(clickEvent(new FixtureAnchor("https://example.test/path")));
  assert.equal(fixture.externalRequests.length, 0);
  assert.equal(fixture.window.open("https://example.test/path"), "embedded-window");
  assert.deepEqual(fixture.externalRequests, []);

  fixture.userActivation.isActive = true;
  const routedAnchor = clickEvent(new FixtureAnchor("../article?q=term#section"));
  handler(routedAnchor);
  assert.equal(routedAnchor.defaultPrevented, false);
  assert.equal(fixture.externalRequests.length, 0);
  fixture.userActivation.isActive = false;
  fixture.runTasks();
  assert.deepEqual(fixture.externalRequests, ["https://chat.example.test/article?q=term#section"]);

  fixture.userActivation.isActive = true;
  const canceledAnchor = clickEvent(new FixtureAnchor("https://example.test/canceled"));
  handler(canceledAnchor);
  canceledAnchor.preventDefault();
  fixture.runTasks();
  assert.equal(fixture.externalRequests.length, 1);

  fixture.userActivation.isActive = true;
  const nativeCanceledAnchor = clickEvent(new FixtureAnchor("https://example.test/native-canceled"));
  handler(nativeCanceledAnchor);
  assert.equal(nativeCanceledAnchor.defaultPrevented, false);
  FixtureClickEvent.prototype.preventDefault.call(nativeCanceledAnchor);
  fixture.runTasks();
  assert.equal(fixture.externalRequests.length, 1);

  const alreadyCanceled = clickEvent(new FixtureAnchor("https://example.test/already-canceled"), { defaultPrevented: true });
  handler(alreadyCanceled);
  fixture.runTasks();
  assert.equal(fixture.externalRequests.length, 1);

  const samePane = clickEvent(new FixtureAnchor("https://example.test/same-pane", "_self"));
  handler(samePane);
  assert.equal(samePane.defaultPrevented, false);
  assert.equal(fixture.externalRequests.length, 1);

  const repeated = clickEvent(new FixtureAnchor("https://example.test/repeated"));
  handler(repeated);
  fixture.runTasks();
  handler(clickEvent(new FixtureAnchor("https://example.test/repeated")));
  fixture.runTasks();
  assert.equal(fixture.externalRequests.length, 3);
  assert.deepEqual(fixture.externalRequests.slice(1), [
    "https://example.test/repeated",
    "https://example.test/repeated",
  ]);
});

test("pending anchor denies its updated HTTP popup without capturing named or non-HTTP windows", () => {
  const pending = [{ kind: "anchor", url: null }];
  for (const target of ["", "_blank", "_BLANK"]) {
    assert.equal(hasPendingExternalNewWindowRequest(pending, "https://example.test/updated", target), true);
  }
  assert.equal(hasPendingExternalNewWindowRequest(pending, "https://example.test/named", "named"), false);
  assert.equal(hasPendingExternalNewWindowRequest(pending, "mailto:person@example.test", "_blank"), false);
  assert.equal(hasPendingExternalNewWindowRequest([], "https://example.test/updated", "_blank"), false);
  assert.equal(hasPendingExternalNewWindowRequest([{ kind: "script", url: "https://example.test/original" }],
    "https://example.test/updated", "_blank"), false);
});

test("top static navigation capture leaves a page-rewritten target to its default action", () => {
  const source = readFileSync(new URL("../src/guest-preload.ts", import.meta.url), "utf8");
  const start = source.indexOf('document.addEventListener("click",');
  const end = source.indexOf('document.addEventListener("submit",', start);
  assert.ok(start >= 0 && end > start);
  let documentClick;
  const internalNavigation = [];
  runInNewContext(source.slice(start, end), {
    document: { addEventListener: (_type, handler) => { documentClick = handler; } },
    isMainFrame: true,
    window: { location: { protocol: "data:" } },
    linkTarget: (target) => target.closest("a[href]"),
    isExternalNewWindowLink,
    emit: (payload) => internalNavigation.push(payload),
  });
  const fixture = runFrameScript();
  fixture.userActivation.isActive = true;
  const anchor = new FixtureAnchor("https://example.test/reverse-target", "_self");
  const event = clickEvent(anchor);
  fixture.handlers.get("window:click")(event);
  documentClick(event);
  assert.equal(event.defaultPrevented, false);
  anchor.target = "_blank";
  fixture.runTasks();
  assert.deepEqual(internalNavigation, []);
  assert.deepEqual(fixture.externalRequests, ["https://example.test/reverse-target"]);
});

test("anchor default action uses href and target after page dispatch", () => {
  const fixture = runFrameScript();
  const handler = fixture.handlers.get("window:click");
  fixture.userActivation.isActive = true;
  const changed = new FixtureAnchor("https://example.test/old");
  handler(clickEvent(changed));
  changed.href = "../final?q=1#part";
  fixture.userActivation.isActive = false;
  fixture.runTasks();
  assert.deepEqual(fixture.externalRequests, ["https://chat.example.test/final?q=1#part"]);

  fixture.userActivation.isActive = true;
  const internal = new FixtureAnchor("https://example.test/old");
  handler(clickEvent(internal));
  internal.target = "_self";
  internal.href = "https://example.test/internal";
  fixture.runTasks();
  assert.equal(fixture.externalRequests.length, 1);

  const newlyExternal = new FixtureAnchor("mailto:old@example.test", "_self");
  handler(clickEvent(newlyExternal));
  newlyExternal.target = "_blank";
  newlyExternal.href = "https://example.test/new";
  fixture.runTasks();
  assert.deepEqual(fixture.externalRequests.slice(1), ["https://example.test/new"]);

  const nonHttp = new FixtureAnchor("https://example.test/old");
  handler(clickEvent(nonHttp));
  nonHttp.href = "mailto:final@example.test";
  fixture.runTasks();
  const removed = new FixtureAnchor("https://example.test/removed");
  handler(clickEvent(removed));
  removed.hasHref = false;
  fixture.runTasks();
  assert.equal(fixture.externalRequests.length, 2);
});

test("window.open routes default, empty, and denied new named contexts but preserves existing names", () => {
  const fixture = runFrameScript({ openResults: ["existing-window", null], consumeActivationOnNull: true });
  fixture.userActivation.isActive = true;

  assert.equal(fixture.window.open("https://example.test/default"), null);
  assert.equal(fixture.externalRequests[0], "https://example.test/default");
  assert.equal(fixture.window.open("https://example.test/empty", ""), null);
  assert.equal(fixture.externalRequests[1], "https://example.test/empty");
  assert.equal(fixture.opened.length, 0);

  assert.equal(fixture.window.open("https://example.test/named-existing", "existing-frame", "width=400"), "existing-window");
  assert.equal(fixture.externalRequests.length, 2);
  assert.equal(fixture.opened[0][1], "existing-frame");
  assert.equal(fixture.opened[0][2], `width=400,${EXTERNAL_NEW_WINDOW_FEATURE}=1`);

  assert.equal(fixture.window.open("https://example.test/named-new", "new-frame", "height=300"), null);
  assert.equal(fixture.externalRequests[2], "https://example.test/named-new");
  assert.equal(fixture.opened[1][2], `height=300,${EXTERNAL_NEW_WINDOW_FEATURE}=1`);
  assert.equal(fixture.window.open("https://example.test/parent", "_parent"), "embedded-window");
  assert.equal(fixture.window.open("https://example.test/top", "_top"), "embedded-window");
});

test("external new-context marker is parsed from Electron window features", () => {
  assert.equal(appendExternalNewWindowFeature("width=400"), `width=400,${EXTERNAL_NEW_WINDOW_FEATURE}=1`);
  assert.equal(appendExternalNewWindowFeature(undefined), `${EXTERNAL_NEW_WINDOW_FEATURE}=1`);
  assert.equal(hasExternalNewWindowFeature(`width=400, ${EXTERNAL_NEW_WINDOW_FEATURE}=1`), true);
  assert.equal(hasExternalNewWindowFeature("width=400,noopener"), false);
  assert.equal(hasExternalNewWindowFeature(`${EXTERNAL_NEW_WINDOW_FEATURE}=0`), false);
});

test("frame fixture routes only active HTTP(S) new-window requests and leaves same-context calls alone", () => {
  const fixture = runFrameScript({ openResults: ["embedded-window", "named-window"] });
  const handler = fixture.handlers.get("window:click");
  const inactive = clickEvent(new FixtureAnchor("https://example.test/inactive"));
  handler(inactive);
  assert.equal(inactive.defaultPrevented, false);
  assert.equal(fixture.externalRequests.length, 0);

  fixture.userActivation.isActive = true;
  assert.equal(fixture.window.open("https://example.test/same", "_self"), "embedded-window");
  assert.equal(fixture.window.open("https://example.test/named", "existing-frame"), "named-window");
  assert.equal(fixture.window.open("", "_blank"), "embedded-window");
  assert.equal(fixture.window.open(undefined, "_blank"), "embedded-window");
  assert.equal(fixture.window.open(null, "_blank"), "embedded-window");
  assert.equal(fixture.window.open("mailto:person@example.test"), "embedded-window");
  assert.equal(fixture.opened.length, 6);
  assert.equal(fixture.externalRequests.length, 0);
});

test("subframes dispatch active HTTP(S) new-window requests locally without opening a popup", () => {
  const fixture = runFrameScript({ subframe: true, openResults: ["existing-frame"] });
  const handler = fixture.handlers.get("window:click");
  const inactive = clickEvent(new FixtureAnchor("https://example.test/iframe"));
  handler(inactive);
  fixture.runTasks();
  assert.equal(inactive.defaultPrevented, false);
  assert.equal(fixture.externalRequests.length, 0);

  fixture.userActivation.isActive = true;
  const routed = clickEvent(new FixtureAnchor("https://example.test/iframe?q=1#part"));
  handler(routed);
  fixture.runTasks();
  assert.equal(routed.defaultPrevented, false);
  assert.deepEqual(fixture.externalRequests, ["https://example.test/iframe?q=1#part"]);
  assert.equal(fixture.opened.length, 0);

  assert.equal(fixture.window.open("https://example.test/scripted"), null);
  assert.equal(fixture.externalRequests[1], "https://example.test/scripted");
  assert.equal(fixture.window.open("https://example.test/named", "existing-frame"), "existing-frame");
  assert.equal(fixture.externalRequests.length, 2);
  assert.equal(fixture.window.open("", "_blank"), "embedded-window");
  assert.equal(fixture.opened.length, 2);
});
