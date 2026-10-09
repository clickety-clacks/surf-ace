import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";

import { parseHTML } from "linkedom";

type ConnectionBar = "connected" | "connecting" | "disconnected";

function pane(paneId: number, annotationBorderVisible = false) {
  return {
    activeKeyboardPane: paneId === 1,
    annotationBorderVisible,
    canGoBack: false,
    canGoForward: false,
    content: {
      content: { markdown: `pane ${paneId}` },
      contentId: `content-${paneId}`,
      contentType: "markdown",
      reloadable: false,
      renderVersion: 1,
      revision: 1,
    },
    displayId: `a${paneId}`,
    drawings: [],
    externalNative: false,
    flushInFlight: false,
    label: String(paneId),
    name: null,
    ownerName: null,
    paneId,
    provenance: null,
    provenanceName: null,
    showDone: annotationBorderVisible,
    toast: null,
    visibleAddress: `a${paneId}`,
  };
}

function state(connectionBar: ConnectionBar, twoPanes = false, annotatingPane = 0) {
  return {
    connectionBar,
    geometryRevision: 1,
    layout: twoPanes
      ? { children: [{ paneId: 1, type: "pane" }, { paneId: 2, type: "pane" }], direction: "vertical", type: "split" }
      : { paneId: 1, type: "pane" },
    name: "test",
    panes: twoPanes ? [pane(1, annotatingPane === 1), pane(2, annotatingPane === 2)] : [pane(1, annotatingPane === 1)],
    providerName: connectionBar === "connected" ? "test-provider" : null,
    surfaceEpoch: "epoch-1",
    surfaceId: "surface-1",
    topologyRevision: twoPanes ? 2 : 1,
    viewport: { height: 800, scale: 1, width: 1200 },
    windowLabel: "a",
  };
}

test("renderer DOM integrates authoritative connection states and live scale controls", async () => {
  const { document, window } = parseHTML(
    "<!doctype html><html lang=\"en\"><body><div id=\"app\"></div><div id=\"provenance-announcer\" aria-atomic=\"true\" aria-live=\"polite\"></div></body></html>",
  );
  let stateListener: ((next: unknown) => void) | null = null;
  let keyboardListener: ((intent: unknown) => void) | null = null;
  let focusStateUpdate: (() => void) | null = null;
  let provenanceWidth = 200;
  let textMetricScale = 1;
  const commands: unknown[] = [];
  const resizeCallbacks: Array<() => void> = [];
  const mutationCallbacks: Array<() => void> = [];
  const fontCallbacks: Array<() => void> = [];
  const surfAce = {
    clearToast() {},
    command(command: unknown) {
      commands.push(command);
      if ((command as { type?: unknown }).type === "focus-pane") {
        focusStateUpdate?.();
      }
    },
    getBootstrap: async () => ({ state: state("disconnected"), surfaceId: "surface-1" }),
    onKeyboardIntent(listener: (intent: unknown) => void) { keyboardListener = listener; },
    onState(listener: (next: unknown) => void) { stateListener = listener; },
    reportDiagnostics() {},
    reportOverlayRegions() {},
    reportRendererDiagnostic() {},
    reportSnapshot() {},
  };

  Object.assign(window, {
    cancelAnimationFrame() {},
    location: { search: "" },
    getComputedStyle: () => ({
      display: "block",
      fontFamily: "Test",
      fontSize: "16px",
      fontStyle: "normal",
      fontWeight: "400",
      opacity: "1",
      visibility: "visible",
    }),
    getSelection: () => null,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
    surfAce,
  });
  Object.assign(globalThis, {
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLCanvasElement: window.HTMLCanvasElement,
    MutationObserver: class {
      constructor(callback: () => void) { mutationCallbacks.push(callback); }
      disconnect() {}
      observe() {}
    },
    ResizeObserver: class {
      constructor(callback: () => void) { resizeCallbacks.push(callback); }
      disconnect() {}
      observe() {}
    },
    window,
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      addEventListener(type: string, callback: () => void) {
        if (type === "loadingdone") fontCallbacks.push(callback);
      },
      ready: Promise.resolve(),
    },
  });
  Object.assign(document, {
    createRange: () => ({ detach() {}, getClientRects: () => [], selectNodeContents() {} }),
  });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      const width = this.classList.contains("navigation-pill__provenance")
        ? provenanceWidth
        : 200;
      return {
        bottom: 100,
        height: 100,
        left: 0,
        right: width,
        top: 0,
        width,
        x: 0,
        y: 0,
      };
    },
  });
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      clearRect() {},
      lineTo() {},
      measureText(text: string) {
        const units = text === "…" ? 10 : text === " — " ? 12 : [...text].length * 8;
        return { width: units * textMetricScale };
      },
      moveTo() {},
      stroke() {},
    }),
  });

  const rendererUrl = pathToFileURL(new URL("../renderer/renderer.js", import.meta.url).pathname).href;
  await import(`${rendererUrl}?integration=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const chrome = () => ({
    glyph: document.querySelector(".pane-label__disconnected")!,
    pane: document.querySelector(".pane-label__number")!,
    window: document.querySelector(".pane-label__window")!,
  });
  assert.equal(chrome().glyph.hasAttribute("hidden"), true);
  assert.equal(chrome().pane.hasAttribute("hidden"), false);
  assert.equal(chrome().window.hasAttribute("hidden"), false);

  stateListener!(state("connecting"));
  assert.equal(chrome().glyph.hasAttribute("hidden"), true);
  assert.equal(chrome().pane.hasAttribute("hidden"), false);
  assert.equal(chrome().window.hasAttribute("hidden"), false);
  stateListener!(state("connected"));
  assert.equal(chrome().glyph.hasAttribute("hidden"), true);
  assert.equal(chrome().pane.hasAttribute("hidden"), false);
  assert.equal(chrome().window.hasAttribute("hidden"), false);
  assert.equal(chrome().pane.textContent, "1");
  assert.equal(chrome().window.textContent, "A");
  assert.equal(document.querySelector(".pane-label")?.getAttribute("title"), "window a pane a1");
  assert.equal(
    document.querySelector(".pane-label")?.getAttribute("aria-label"),
    "Surf Ace window a pane a1",
  );
  stateListener!(state("disconnected"));
  assert.equal(chrome().glyph.hasAttribute("hidden"), true);
  assert.equal(chrome().pane.hasAttribute("hidden"), false);
  assert.equal(chrome().window.hasAttribute("hidden"), false);
  assert.equal(document.querySelector(".pane-label")?.getAttribute("title"), "window a pane a1 disconnected");

  (document.querySelector(".font-size-toggle") as HTMLElement).click();
  (document.querySelector(".font-size-step") as HTMLElement).click();
  (document.querySelector(".font-size-step") as HTMLElement).click();
  assert.equal(document.querySelector(".font-size-reset")?.textContent, "80");
  assert.ok(document.querySelector(".font-size-popover"));

  keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
  assert.equal(document.querySelector(".font-size-reset")?.textContent, "90");
  assert.ok(document.querySelector(".font-size-popover"));
  (document.querySelector(".font-size-toggle") as HTMLElement).click();
  assert.equal(document.querySelector(".font-size-popover"), null);
  (document.querySelector(".font-size-toggle") as HTMLElement).click();
  assert.equal(document.querySelector(".font-size-reset")?.textContent, "90");
  (document.querySelector(".font-size-reset") as HTMLElement).click();
  assert.equal(document.querySelector(".font-size-reset")?.textContent, "100");

  stateListener!(state("connected", true));
  const paneShells = document.querySelectorAll(".pane-shell");
  (paneShells[1]!.querySelector(".font-size-toggle") as HTMLElement).click();
  assert.equal(paneShells[0]!.querySelector(".font-size-popover"), null);
  assert.ok(paneShells[1]!.querySelector(".font-size-popover"));
  stateListener!(state("connected", true, 2));
  assert.equal(document.querySelector(".font-size-popover"), null);

  stateListener!(state("connected", true));
  (document.querySelectorAll(".pane-shell")[0]!.querySelector(".font-size-toggle") as HTMLElement).click();
  document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.equal(document.querySelector(".font-size-popover"), null);
  (document.querySelectorAll(".pane-shell")[0]!.querySelector(".font-size-toggle") as HTMLElement).click();
  document.querySelectorAll(".pane-shell")[0]!.querySelector(".pane-scroll")!
    .dispatchEvent(new window.Event("scroll"));
  assert.equal(document.querySelector(".font-size-popover"), null);

  function provenanceState(
    revision: number,
    provenance: {
      controllerProductName: string | null;
      friendlyChatName: string | null;
    } | null,
  ) {
    const next = state("connected");
    const firstPane = next.panes[0]! as Omit<
      ReturnType<typeof pane>,
      "provenance"
    > & {
      provenance: {
        controllerProductName: string | null;
        friendlyChatName: string | null;
      } | null;
    };
    firstPane.canGoBack = true;
    firstPane.canGoForward = true;
    firstPane.content.revision = revision;
    firstPane.provenance = provenance;
    return next;
  }

  const focusBefore = provenanceState(20, {
    controllerProductName: "Clawline",
    friendlyChatName: "Current",
  });
  focusBefore.panes[0]!.activeKeyboardPane = false;
  const focusAfter = provenanceState(20, {
    controllerProductName: "Clawline",
    friendlyChatName: "Current",
  });
  focusAfter.panes[0]!.activeKeyboardPane = true;
  stateListener!(focusBefore);
  const pointerBack = document.querySelector(
    '[data-surf-ace-overlay="history-back"]',
  ) as HTMLElement;
  assert.ok(pointerBack);
  const pointerCommandsStart = commands.length;
  focusStateUpdate = () => stateListener!(focusAfter);
  for (const type of ["pointerdown", "mousedown"] as const) {
    pointerBack.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  }
  assert.equal(pointerBack.isConnected, true, "pointer focus must not replace the active Back control");
  assert.equal(
    document.querySelector('[data-surf-ace-overlay="history-back"]'),
    pointerBack,
    "pointer focus must preserve Back control identity through the state refresh",
  );
  for (const type of ["pointerup", "mouseup"] as const) {
    pointerBack.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  }
  assert.equal(pointerBack.isConnected, true, "pointer focus must preserve Back through pointer release");
  assert.equal(
    document.querySelector('[data-surf-ace-overlay="history-back"]'),
    pointerBack,
    "pointer release must preserve the same Back control for click",
  );
  if (pointerBack.isConnected) {
    pointerBack.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  }
  focusStateUpdate = null;
  const pointerCommands = commands.slice(pointerCommandsStart) as Array<{ paneId?: number; type?: string; direction?: string }>;
  const focusCommands = pointerCommands.filter((command) => command.type === "focus-pane");
  assert.ok(focusCommands.length >= 1, "the genuine pointer sequence must remember pane focus");
  assert.deepEqual(
    pointerCommands.filter((command) => command.type === "history"),
    [{ direction: "back", paneId: 1, type: "history" }],
    "the stable Back control must produce exactly one history navigation",
  );

  provenanceWidth = 200;
  stateListener!(provenanceState(2, {
    controllerProductName: "\u3000Clawline\u0085",
    friendlyChatName: "\u0085OpenClaw\u3000",
  }));
  await Promise.resolve();
  let provenanceLabel = document.querySelector(
    ".navigation-pill__provenance",
  ) as HTMLElement;
  assert.equal(provenanceLabel.textContent, "OpenClaw — Clawline");
  assert.equal(
    provenanceLabel.getAttribute("aria-label"),
    "Pushed by \u2068OpenClaw\u2069, using \u2068Clawline\u2069",
  );
  assert.equal(provenanceLabel.getAttribute("role"), "group");
  assert.equal(provenanceLabel.hasAttribute("tabindex"), false);
  assert.equal(provenanceLabel.querySelectorAll("bdi").length, 2);
  assert.deepEqual(
    [...provenanceLabel.querySelectorAll("bdi")].map((element) =>
      element.getAttribute("dir")
    ),
    ["auto", "auto"],
  );
  assert.deepEqual(
    [...provenanceLabel.querySelectorAll("bdi")].map((element) =>
      element.getAttribute("aria-hidden")
    ),
    ["true", "true"],
  );
  assert.equal(
    provenanceLabel.classList.contains(
      "navigation-pill__provenance--composite",
    ),
    true,
  );
  const suppliedComponents = provenanceLabel.querySelectorAll<HTMLElement>(
    ".navigation-pill__provenance-component",
  );
  assert.equal(
    suppliedComponents[0]!.style.getPropertyValue("inline-size"),
    "64px",
  );
  assert.equal(
    suppliedComponents[1]!.style.getPropertyValue("inline-size"),
    "64px",
  );

  let provenanceRevision = 3;
  const fallbackCases = [
    [{ controllerProductName: null, friendlyChatName: "OpenClaw" }, "OpenClaw — Unknown provider", "OpenClaw — Proveedor desconocido"],
    [{ controllerProductName: "Clawline", friendlyChatName: null }, "Unknown chat — Clawline", "Chat desconocido — Clawline"],
    [null, "Unknown chat — Unknown provider", "Chat desconocido — Proveedor desconocido"],
    [{ controllerProductName: "", friendlyChatName: "" }, "Unknown chat — Unknown provider", "Chat desconocido — Proveedor desconocido"],
    [{ controllerProductName: "\u3000", friendlyChatName: "\u0085" }, "Unknown chat — Unknown provider", "Chat desconocido — Proveedor desconocido"],
  ] as const;
  for (const [language, expectedIndex] of [["en", 1], ["es", 2]] as const) {
    document.documentElement.lang = language;
    for (const callback of mutationCallbacks) callback();
    for (const [provenance, english, spanish] of fallbackCases) {
      stateListener!(provenanceState(provenanceRevision++, provenance));
      assert.equal(
        document.querySelector(".navigation-pill__provenance")?.textContent,
        expectedIndex === 1 ? english : spanish,
      );
    }
  }

  document.documentElement.lang = "en";
  for (const callback of mutationCallbacks) callback();
  stateListener!(provenanceState(provenanceRevision++, {
    controllerProductName: "abcdefghijklmnopqrstuvwxyz",
    friendlyChatName: "A",
  }));
  await Promise.resolve();
  provenanceLabel = document.querySelector(
    ".navigation-pill__provenance",
  ) as HTMLElement;
  const components = provenanceLabel.querySelectorAll<HTMLElement>(
    ".navigation-pill__provenance-component",
  );
  assert.equal(components[0]!.style.getPropertyValue("inline-size"), "8px");
  assert.equal(components[1]!.style.getPropertyValue("inline-size"), "180px");

  stateListener!(provenanceState(provenanceRevision++, {
    controllerProductName: "B",
    friendlyChatName: "abcdefghijklmnopqrstuvwxyz",
  }));
  await Promise.resolve();
  provenanceLabel = document.querySelector(
    ".navigation-pill__provenance",
  ) as HTMLElement;
  const reverseComponents = provenanceLabel.querySelectorAll<HTMLElement>(
    ".navigation-pill__provenance-component",
  );
  assert.equal(
    reverseComponents[0]!.style.getPropertyValue("inline-size"),
    "180px",
  );
  assert.equal(
    reverseComponents[1]!.style.getPropertyValue("inline-size"),
    "8px",
  );

  const directionalLabels = [
    {
      controllerProductName: "LongProviderProductNameForTruncation",
      friendlyChatName: "LongFriendlyChatNameForTruncation",
    },
    {
      controllerProductName: "مزودطويلللغايةللاقتطاع",
      friendlyChatName: "محادثةطويلةللغايةللاقتطاع",
    },
    {
      controllerProductName: "Clawline مزود طويل",
      friendlyChatName: "OpenClaw محادثة طويلة",
    },
  ];
  const widthModes = [
    [200, "navigation-pill__provenance--composite"],
    [20, "navigation-pill__provenance--collapsed"],
    [5, "navigation-pill__provenance--zero-width"],
  ] as const;
  for (const provenance of directionalLabels) {
    for (const [width, className] of widthModes) {
      provenanceWidth = width;
      stateListener!(provenanceState(provenanceRevision++, provenance));
      await Promise.resolve();
      provenanceLabel = document.querySelector(
        ".navigation-pill__provenance",
      ) as HTMLElement;
      for (const callback of resizeCallbacks) callback();
      assert.equal(provenanceLabel.classList.contains(className), true);
      assert.equal(provenanceLabel.querySelectorAll("bdi").length, 2);
      assert.equal(
        provenanceLabel.getAttribute("aria-label"),
        "Pushed by \u2068" + provenance.friendlyChatName + "\u2069, using \u2068" +
          provenance.controllerProductName + "\u2069",
      );
      if (className === "navigation-pill__provenance--composite") {
        const shares = provenanceLabel.querySelectorAll<HTMLElement>(
          ".navigation-pill__provenance-component",
        );
        assert.equal(shares[0]!.style.getPropertyValue("inline-size"), "94px");
        assert.equal(shares[1]!.style.getPropertyValue("inline-size"), "94px");
      }
      assert.ok(document.querySelector('[data-surf-ace-overlay="history-back"]'));
      assert.ok(document.querySelector('[data-surf-ace-overlay="history-forward"]'));
    }
  }

  provenanceWidth = 200;
  stateListener!(provenanceState(4, {
    controllerProductName: "\u3000",
    friendlyChatName: "\u0085",
  }));
  document.documentElement.lang = "es";
  for (const callback of mutationCallbacks) callback();
  await Promise.resolve();
  provenanceLabel = document.querySelector(
    ".navigation-pill__provenance",
  ) as HTMLElement;
  assert.equal(
    provenanceLabel.textContent,
    "Chat desconocido — Proveedor desconocido",
  );
  assert.equal(
    provenanceLabel.getAttribute("aria-label"),
    "Enviado por \u2068Chat desconocido\u2069, usando \u2068Proveedor desconocido\u2069",
  );

  textMetricScale = 2;
  document.documentElement.setAttribute("style", "font-size: 200%");
  for (const callback of mutationCallbacks) callback();
  assert.equal(provenanceLabel.dataset.collapsedMinimumWidth, "20");
  assert.equal(provenanceLabel.dataset.compositeMinimumWidth, "64");
  for (const callback of fontCallbacks) callback();
  assert.equal(provenanceLabel.dataset.compositeMinimumWidth, "64");
  for (const [width, className] of [
    [100, "navigation-pill__provenance--composite"],
    [40, "navigation-pill__provenance--collapsed"],
    [10, "navigation-pill__provenance--zero-width"],
  ] as const) {
    provenanceWidth = width;
    for (const callback of resizeCallbacks) callback();
    assert.equal(provenanceLabel.classList.contains(className), true);
    assert.ok(document.querySelector('[data-surf-ace-overlay="history-back"]'));
    assert.ok(document.querySelector('[data-surf-ace-overlay="history-forward"]'));
  }

  textMetricScale = 1;
  provenanceWidth = 200;
  document.documentElement.lang = "en";
  for (const callback of mutationCallbacks) callback();
  stateListener!(provenanceState(10, {
    controllerProductName: "Clawline",
    friendlyChatName: "Current",
  }));
  (
    document.querySelector(
      '[data-surf-ace-overlay="history-back"]',
    ) as HTMLElement
  ).click();
  assert.deepEqual(commands.slice(-2), [
    { paneId: 1, type: "focus-pane" },
    { direction: "back", paneId: 1, type: "history" },
  ]);
  stateListener!(provenanceState(9, {
    controllerProductName: "Tight Beam",
    friendlyChatName: "Prior",
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const announcer = document.querySelector("#provenance-announcer")!;
  assert.equal(
    announcer.textContent,
    "Pushed by \u2068Prior\u2069, using \u2068Tight Beam\u2069",
  );
  assert.equal(
    document.querySelector('[data-surf-ace-overlay="history-back"]')
      ?.getAttribute("aria-label"),
    "Back",
  );

  (
    document.querySelector(
      '[data-surf-ace-overlay="history-forward"]',
    ) as HTMLElement
  ).click();
  stateListener!(provenanceState(10, {
    controllerProductName: "Clawline",
    friendlyChatName: "Current",
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    announcer.textContent,
    "Pushed by \u2068Current\u2069, using \u2068Clawline\u2069",
  );
  assert.equal(
    document.querySelector('[data-surf-ace-overlay="history-forward"]')
      ?.getAttribute("aria-label"),
    "Forward",
  );
  await test("webview scaling waits for dom-ready across attach and navigation", async () => {
    for (const revision of [20, 21]) {
      const next = state("connected");
      Object.assign(next.panes[0]!.content, {
        content: { html: "<html><body>ready</body></html>" },
        contentType: "html",
        contentId: "webview-" + revision,
        renderVersion: revision,
        revision,
      });
      stateListener!(next);
      const webview = document.querySelector("webview") as HTMLElement & {
        executeJavaScript: (script: string) => Promise<unknown>;
      };
      assert.ok(webview);
      let ready = false;
      const scripts: string[] = [];
      webview.executeJavaScript = (script) => {
        if (!ready) throw new Error("guest called before dom-ready");
        scripts.push(script);
        return Promise.resolve(null);
      };
      assert.doesNotThrow(() => webview.dispatchEvent(new window.Event("did-attach")));
      assert.doesNotThrow(() => webview.dispatchEvent(new window.Event("did-attach")));
      assert.equal(scripts.length, 0);
      ready = true;
      webview.dispatchEvent(new window.Event("dom-ready"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(scripts.some((script) => script.includes("document.documentElement.style.zoom")),
        "scale initialization still runs after dom-ready");
      const firstScales = scripts.filter((script) => script.includes("document.documentElement.style.zoom")).length;
      webview.dispatchEvent(new window.Event("did-start-loading"));
      webview.dispatchEvent(new window.Event("dom-ready"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(scripts.filter((script) => script.includes("document.documentElement.style.zoom")).length > firstScales,
        "navigation reapplies scale after the next dom-ready");
    }
  });

  await test("zoom refits only the ready guest without shared-origin zoom or remount", async () => {
    const next = state("connected", true);
    for (const [index, pane] of next.panes.entries()) Object.assign(pane.content, {
      content: { url: "https://fixture.invalid/same-origin" }, contentType: "browser_url",
      contentId: `guest-${index}`, revision: 40, renderVersion: 40,
    });
    stateListener!(next);
    const guests = [...document.querySelectorAll("webview")] as Array<HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> }>;
    assert.equal(guests.length, 2);
    const contexts = guests.map(() => {
      const root = { style: { zoom: "" } };
      const result = { columns: 40, resizeEvents: 0 };
      return {
        document: { documentElement: root, body: { style: { setProperty() {} } } },
        Event: class { constructor(public type: string) {} },
        window: { dispatchEvent(event: { type: string }) {
          if (event.type === "resize") {
            result.resizeEvents++;
            result.columns = Math.floor(400 / (10 * (Number(root.style.zoom) || 1)));
          }
        } }, result,
      };
    });
    guests.forEach((guest, index) => {
      guest.executeJavaScript = async (code) => {
        if (code.includes("document.documentElement.style.zoom")) runInNewContext(code, contexts[index]);
        return null;
      };
      guest.dispatchEvent(new window.Event("dom-ready"));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(contexts[0]!.document.documentElement.style.zoom, "0.85");
    assert.equal(contexts[0]!.result.columns, 47, "default base zoom must trigger refitting");
    const otherEvents = contexts[1]!.result.resizeEvents;
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    assert.equal(contexts[0]!.document.documentElement.style.zoom, "0.935");
    assert.equal(contexts[0]!.result.columns, 42);
    assert.equal(contexts[1]!.document.documentElement.style.zoom, "0.85");
    assert.equal(contexts[1]!.result.resizeEvents, otherEvents);
    assert.deepEqual([...document.querySelectorAll("webview")], guests);
    guests[0]!.dispatchEvent(new window.Event("did-start-loading"));
    const prior = contexts[0]!.result.resizeEvents;
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    assert.equal(contexts[0]!.result.resizeEvents, prior, "loading guest cannot run scale methods");
    guests[0]!.dispatchEvent(new window.Event("dom-ready"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(contexts[0]!.document.documentElement.style.zoom, "1.02");
    assert.equal(contexts[0]!.result.columns, 39);
  });

  await test("weighted layout, split, reorder and close retain surviving guest ancestry", async () => {
    const next = state("connected", true);
    for (const [index, pane] of next.panes.entries()) Object.assign(pane.content, {
      content: { url: `https://fixture.invalid/${index}` }, contentType: "browser_url",
      contentId: `retain-${index}`, revision: 50, renderVersion: 50,
    });
    stateListener!(next);
    const wrapper = document.querySelector(".surface-window")!;
    const hosts = document.querySelector(".pane-host-layer")!;
    const guests = [...document.querySelectorAll("webview")];
    const ancestry = guests.map((guest) => {
      const chain = [];
      for (let element: Element | null = guest; element; element = element.parentElement) chain.push(element);
      return chain;
    });
    const check = (remaining = guests) => {
      assert.equal(document.querySelector(".surface-window"), wrapper);
      assert.equal(document.querySelector(".pane-host-layer"), hosts);
      remaining.forEach((guest) => {
        assert.equal(guest.isConnected, true);
        const index = guests.indexOf(guest);
        let element: Element | null = guest;
        for (const ancestor of ancestry[index]!) { assert.equal(element, ancestor); element = element!.parentElement; }
      });
    };
    const weights = structuredClone(next);
    assert.ok(weights.layout.children);
    Object.assign(weights.layout.children[0]!, { weight: 3 });
    Object.assign(weights.layout.children[1]!, { weight: 1 });
    weights.topologyRevision++;
    weights.geometryRevision++;
    stateListener!(weights);
    check();
    const split = structuredClone(weights);
    split.panes.push(pane(3));
    Object.assign(split.layout, { children: [
      { type: "split", direction: "horizontal", weight: 3, children: [{ type: "pane", paneId: 1, weight: 1 }, { type: "pane", paneId: 3, weight: 2 }] },
      { type: "pane", paneId: 2, weight: 1 },
    ] });
    split.topologyRevision++;
    stateListener!(split);
    check();
    const reordered = structuredClone(split);
    assert.ok(reordered.layout.children);
    reordered.layout.children.reverse();
    reordered.topologyRevision++;
    stateListener!(reordered);
    check();
    const closed = structuredClone(next);
    closed.panes = [closed.panes[0]!];
    Object.assign(closed, { layout: { type: "pane", paneId: 1 }, topologyRevision: 10 });
    stateListener!(closed);
    check([guests[0]!]);
    assert.equal(guests[1]!.isConnected, false, "only closed guest is removed");
  });

  await test("separator previews latest frame and sends one fenced release, cancel and failure restore", async () => {
    const next = state("connected", true);
    stateListener!(next);
    const wrapper = document.querySelector(".surface-window");
    const roots = [...document.querySelectorAll(".pane-shell")];
    let queued = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => { queued.set(++frameId, callback); return frameId; };
    window.cancelAnimationFrame = (id: number) => { queued.delete(id); };
    const flush = () => { const callbacks = [...queued.values()]; queued.clear(); callbacks.forEach((callback) => callback(0)); };
    const commits: Array<any> = [];
    let finishCommit: ((value: boolean) => void) | null = null;
    Object.assign(surfAce, { resizeSplit(payload: any) {
      commits.push(payload);
      return new Promise<boolean>((resolve) => { finishCommit = resolve; });
    } });
    const pointer = (target: EventTarget, type: string, x: number, id = 1) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: id, clientX: x, clientY: x });
      target.dispatchEvent(event);
    };
    const handle = () => {
      const element = document.querySelector(".split-resize-handle") as HTMLElement;
      Object.assign(element, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
      return element;
    };
    pointer(handle(), "pointerdown", 100);
    pointer(window, "pointermove", 110);
    pointer(window, "pointermove", 130);
    pointer(window, "pointermove", 150);
    assert.equal(commits.length, 0);
    flush();
    assert.equal((document.querySelector(".pane-layout-slot") as HTMLElement).style.flexGrow, "1.5");
    pointer(window, "pointerup", 160);
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].weights, [1.6, 0.3999999999999999]);
    assert.equal(commits[0].expected.surfaceEpoch, next.surfaceEpoch);
    assert.equal(commits[0].expected.topologyRevision, next.topologyRevision);
    assert.deepEqual(commits[0].expected.layout, next.layout);
    pointer(handle(), "pointerdown", 100);
    pointer(window, "pointerup", 150);
    assert.equal(commits.length, 1, "pending commit shields against backlog of newer gestures");
    finishCommit!(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(document.querySelector(".resize-status")!.textContent!, /couldn’t be confirmed/);
    assert.equal((document.querySelector(".pane-layout-slot") as HTMLElement).style.flexGrow, "1");
    assert.equal(document.querySelector(".surface-window"), wrapper);
    assert.deepEqual([...document.querySelectorAll(".pane-shell")], roots);
    const registryUpdate = structuredClone(next);
    registryUpdate.connectionBar = "disconnected";
    Object.assign(registryUpdate, { connectionError: "allocator unavailable" });
    stateListener!(registryUpdate);
    assert.match(document.querySelector(".resize-status")!.textContent!, /couldn’t be confirmed/);
    assert.match(document.querySelector(".connection-status-banner")!.textContent!, /allocator unavailable/);
    stateListener!({ ...registryUpdate, panes: registryUpdate.panes.map((pane) => ({ ...pane, name: "content update" })) });
    assert.match(document.querySelector(".resize-status")!.textContent!, /couldn’t be confirmed/);
    pointer(handle(), "pointerdown", 100);
    assert.equal(document.querySelector(".resize-status"), null);
    assert.match(document.querySelector(".connection-status-banner")!.textContent!, /allocator unavailable/);
    pointer(window, "pointermove", 150);
    flush();
    pointer(window, "pointercancel", 150);
    stateListener!(next);
    flush();
    assert.equal(commits.length, 1);
    assert.equal((document.querySelector(".pane-layout-slot") as HTMLElement).style.flexGrow, "1");
    pointer(handle(), "pointerdown", 100);
    pointer(window, "pointerup", 100);
    assert.equal(commits.length, 1, "no-op end sends no mutation");
    pointer(handle(), "pointerdown", 100);
    pointer(window, "pointermove", 140);
    const concurrent = structuredClone(next);
    assert.ok(concurrent.layout.children);
    concurrent.topologyRevision++;
    Object.assign(concurrent.layout.children[0]!, { weight: 2 });
    stateListener!(concurrent);
    pointer(window, "pointerup", 150);
    flush();
    assert.equal(commits.length, 1, "concurrent authoritative layout cancels old gesture");
    assert.equal((document.querySelector(".pane-layout-slot") as HTMLElement).style.flexGrow, "2");
    pointer(handle(), "pointerdown", 100);
    pointer(window, "pointerup", 110);
    assert.equal(commits.length, 2, "new gesture reads current authoritative weights");
    assert.equal(commits[1].expected.topologyRevision, concurrent.topologyRevision);
    finishCommit!(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelector(".resize-status"), null);
    const unequal = structuredClone(concurrent);
    Object.assign(unequal.layout, { direction: "horizontal" });
    assert.ok(unequal.layout.children);
    Object.assign(unequal.layout.children[0]!, { weight: 0.01 });
    Object.assign(unequal.layout.children[1]!, { weight: 0.99 });
    unequal.topologyRevision++;
    stateListener!(unequal);
    pointer(handle(), "pointerdown", 100);
    pointer(window, "pointerup", 100);
    assert.equal(commits.length, 2, "a no-op cannot clamp existing unequal weights");
    pointer(handle(), "pointerdown", 100);
    pointer(window, "pointermove", 125);
    flush();
    assert.equal((document.querySelector(".pane-layout-slot") as HTMLElement).style.flexGrow, "0.26");
    pointer(window, "pointerup", 125);
    assert.equal(commits.length, 3);
    assert.deepEqual(commits[2].weights, [0.26, 0.74]);
    finishCommit!(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    pointer(handle(), "pointerdown", 100);
    pointer(window, "pointermove", 130);
    const rotated = structuredClone(unequal);
    rotated.geometryRevision++;
    rotated.viewport = { ...rotated.viewport, width: 800, height: 1200 };
    stateListener!(rotated);
    pointer(window, "pointerup", 130);
    flush();
    assert.equal(commits.length, 3, "resize/rotation cancels captured old coordinates");
    queued.clear();
  });

});
