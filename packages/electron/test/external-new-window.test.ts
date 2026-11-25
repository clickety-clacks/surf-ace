import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  externalNewWindowFrameScript,
  embeddedNewWindowAction,
  isExternalNewWindowLink,
  resolveExternalHttpUrl,
} from "../src/external-new-window.js";

class FixtureElement {
  constructor(readonly link: FixtureAnchor | null = null) {}

  closest(selector: string): FixtureAnchor | null {
    assert.equal(selector, "a[href]");
    return this.link;
  }
}

class FixtureAnchor extends FixtureElement {
  constructor(readonly href: string, readonly target = "_blank") {
    super();
  }
}

function runFrameScript() {
  const handlers = new Map<string, (event: unknown) => void>();
  const messages: unknown[] = [];
  const opened: unknown[][] = [];
  const userActivation = { isActive: false };
  const window = {
    top: { postMessage: (message: unknown) => messages.push(message) },
    open: (...args: unknown[]) => {
      opened.push(args);
      return "embedded-window";
    },
  };
  const document = {
    baseURI: "https://chat.example.test/messages/thread",
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
  };
  runInNewContext(externalNewWindowFrameScript, {
    document,
    Element: FixtureElement,
    HTMLAnchorElement: FixtureAnchor,
    navigator: { userActivation },
    queueMicrotask,
    Reflect,
    URL,
    window,
  });
  return { document, handlers, messages, opened, userActivation, window };
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

test("static fixture routes only active HTTP(S) new-window requests and leaves same-pane links alone", () => {
  const fixture = runFrameScript();
  let prevented = false;
  fixture.handlers.get("click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("https://example.test/path")),
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, false);
  assert.deepEqual(fixture.messages, []);
  assert.equal(fixture.window.open("https://example.test/path"), "embedded-window");
  assert.deepEqual(fixture.messages, []);

  fixture.userActivation.isActive = true;
  fixture.handlers.get("click")?.({
    isTrusted: true,
    target: new FixtureElement(new FixtureAnchor("../article?q=term#section")),
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(fixture.messages.length, 1);
  assert.equal((fixture.messages[0] as { type: string }).type, "surf-ace-external-new-window");
  assert.equal((fixture.messages[0] as { url: string }).url, "https://chat.example.test/article?q=term#section");
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
  assert.equal(fixture.messages.length, 2);
  assert.equal((fixture.messages[1] as { type: string }).type, "surf-ace-external-new-window");
  assert.equal((fixture.messages[1] as { url: string }).url, "https://example.test/scripted");
});
