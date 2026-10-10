import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";

import { parseHTML } from "linkedom";
import { queuedAuthorityRace } from "./pane-presentation-authority-race.js";

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
    paneLineageId: `lineage-${paneId}`,
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
  let ownershipListener: ((notice: unknown) => void) | null = null;
  let stateListener: ((next: unknown) => void) | null = null;
  let keyboardListener: ((intent: unknown) => void) | null = null;
  let focusStateUpdate: (() => void) | null = null;
  let provenanceWidth = 200;
  let textMetricScale = 1;
  const commands: unknown[] = [];
  const presentations: Record<string, unknown>[] = [];
  let presentationResponse: (() => Promise<{ ok: boolean; error?: string; revision?: number; authorityRevision?: number; presentationCleared?: boolean; presentationBlocked?: boolean }>) | null = null;
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
    onPanePresentationOwnership(listener: (notice: unknown) => void) { ownershipListener = listener; },
    onKeyboardIntent(listener: (intent: unknown) => void) { keyboardListener = listener; },
    onState(listener: (next: unknown) => void) { stateListener = listener; },
    reportDiagnostics() {},
    reportOverlayRegions() {},
    reportRendererDiagnostic() {},
    reportSnapshot() {},
    async setPanePresentation(request: Record<string, unknown>) {
      presentations.push(request);
      return presentationResponse ? presentationResponse() : { ok: true };
    },
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
      setTransform() {},
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

  await test("pop-out keeps nested weighted slots and live hosts through restore and topology races", async () => {
    focusStateUpdate = null;
    const next: Omit<ReturnType<typeof state>, "layout"> & { layout: unknown } = state("connected", true);
    const third = pane(3);
    next.panes.push(third);
    next.layout = {
      type: "split", direction: "vertical", children: [
        { type: "pane", paneId: 1, weight: 2 },
        { type: "split", direction: "horizontal", weight: 5, children: [
          { type: "pane", paneId: 2, weight: 3 },
          { type: "pane", paneId: 3, weight: 7 },
        ] },
      ],
    };
    Object.assign(next.panes[1]!.content, {
      content: { html: "<html><body>stateful</body></html>" },
      contentType: "html", contentId: "pop-out-content", renderVersion: 50, revision: 50,
    });
    stateListener!(next);
    const roots = [...document.querySelectorAll<HTMLElement>(".pane-shell")];
    const slots = [...document.querySelectorAll<HTMLElement>(".pane-slot")];
    const selected = roots[1]!;
    const liveHost = selected.querySelector("webview")! as HTMLElement & { pageCounter: number };
    liveHost.pageCounter = 9;
    const siblingContent = roots[0]!.querySelector(".pane-content")!;
    const topologyBefore = JSON.stringify(next.layout);
    const slotWeights = slots.map((slot) => slot.style.flexGrow);
    const toggle = selected.querySelector<HTMLButtonElement>(".pane-pop-out")!;
    assert.equal(toggle.closest(".annotation-pill")?.querySelector(".font-size-toggle") !== null, true);
    assert.equal(toggle.closest(".annotation-pill")?.querySelector(".annotate") !== null, true);
    assert.equal(toggle.closest(".control-cluster") !== null, true, "Solo belongs to the bottom toolbar");
    assert.equal(toggle.parentElement !== selected, true, "no root-level oversized top-right control");
    assert.equal(toggle.textContent, "", "icon-only control");
    assert.equal(toggle.querySelector("svg")?.getAttribute("aria-hidden"), "true");
    assert.equal(toggle.getAttribute("aria-label"), "Solo pane 2");
    const commandsBefore = commands.length;
    presentationResponse = async () => ({ ok: false, error: "unsupported compositor" });
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selected.classList.contains("pane-popped-out"), false);
    assert.equal(toggle.title, "unsupported compositor");
    presentationResponse = null;
    let acknowledgeInitial!: (response: { ok: boolean }) => void;
    presentationResponse = () => new Promise((resolve) => { acknowledgeInitial = resolve; });
    toggle.click();
    const oldSketch = selected.querySelector(".annotate");
    const oldFont = selected.querySelector(".font-size-toggle");
    stateListener!({ ...next, connectionBar: "connecting" });
    assert.notEqual(selected.querySelector(".annotate"), oldSketch, "chrome change actually rebuilds Sketch");
    assert.notEqual(selected.querySelector(".font-size-toggle"), oldFont, "chrome change actually rebuilds Font");
    assert.equal(selected.querySelector(".pane-pop-out"), toggle, "pending state churn retains the same button");
    assert.equal(toggle.closest("[inert]"), null, "pending toolbar cannot shield Restore itself");
    assert.equal(toggle.closest(".control-cluster")!.classList.contains("collapsed"), false);
    assert.ok(selected.querySelector(".font-size-toggle")!.closest("[inert]"), "pending font control stays shielded");
    assert.ok(selected.querySelector(".annotate")!.closest("[inert]"), "pending annotation control stays shielded");
    acknowledgeInitial({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selected.classList.contains("pane-popped-out"), true,
      "unrelated state refresh cannot discard an acknowledged initial transition");
    assert.equal(selected.querySelector(".annotate")!.closest("[inert]"), null, "settled enter unshields rebuilt controls");
    presentationResponse = null;
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    stateListener!(next);
    for (let cycle = 0; cycle < 3; cycle++) {
      toggle.click();
      assert.equal(selected.classList.contains("pane-popped-out"), false, "pending ack retains tiled display");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(toggle.textContent, "");
      assert.equal(toggle.getAttribute("aria-label"), "Restore pane 2");
      assert.equal(toggle.getAttribute("aria-expanded"), "true");
      assert.equal(selected.classList.contains("pane-popped-out"), true);
      assert.equal(roots[0]!.hasAttribute("inert"), true);
      assert.equal(roots[2]!.getAttribute("aria-hidden"), "true");
      assert.equal(selected.parentElement?.classList.contains("pane-host-layer"), true, "retained host stays outside tiled skeleton");
      const divider = document.querySelector<HTMLElement>(".split-resize-handle")!;
      const blockedDrag = new window.Event("pointerdown", { bubbles: true, cancelable: true });
      Object.assign(blockedDrag, { pointerId: 80 + cycle, clientX: 100, clientY: 100 });
      divider.dispatchEvent(blockedDrag);
      assert.equal(blockedDrag.defaultPrevented, false, "expanded presentation cannot start a tiled resize");
      assert.equal(liveHost.isConnected, true);
      liveHost.pageCounter++;
      siblingContent.setAttribute("data-live-tick", String(cycle));
      window.dispatchEvent(new window.Event("resize"));
      selected.querySelector(".pane-scroll")!.dispatchEvent(new window.Event("scroll"));
      assert.equal(toggle.isConnected, true, "toolbar collapse cannot remove Restore");
      assert.equal(selected.querySelector(".pane-pop-out"), toggle, "same toggle survives control rebuilds");
      assert.equal(toggle.closest(".control-cluster")!.classList.contains("collapsed"), false,
        "expanded Restore stays reachable after content/scroll collapse attempts");
      assert.equal(toggle.getAttribute("aria-label"), "Restore pane 2");
      assert.equal(toggle.getAttribute("aria-pressed"), "true");
      toggle.click();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      assert.equal(toggle.getAttribute("aria-pressed"), "false");
      assert.equal(selected.classList.contains("pane-popped-out"), false);
      assert.equal(roots[0]!.hasAttribute("inert"), false);
      assert.equal(selected.querySelector("webview"), liveHost);
      assert.deepEqual(slots.map((slot) => slot.style.flexGrow), slotWeights);
    }
    // A native resize cannot move the retained DOM ahead of its acknowledgement.
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const oldWidth = selected.style.width;
    let acknowledgeResize!: (response: { ok: boolean }) => void;
    presentationResponse = () => new Promise((resolve) => { acknowledgeResize = resolve; });
    window.dispatchEvent(new window.Event("resize"));
    assert.equal(selected.querySelector(".pane-content")!.hasAttribute("inert"), true);
    assert.equal(toggle.hasAttribute("inert"), false, "Restore remains available during resize");
    const resized = { ...next, viewport: { ...next.viewport, width: 1000, height: 700 },
      geometryRevision: next.geometryRevision + 1 };
    stateListener!(resized);
    assert.equal(selected.style.width, oldWidth, "pending resize keeps last acknowledged geometry");
    assert.equal(selected.querySelector("webview"), liveHost);
    acknowledgeResize({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selected.style.width, "972px");
    assert.equal(selected.style.left, "14px");
    assert.equal(selected.querySelector(".pane-content")!.hasAttribute("inert"), false);
    assert.equal(presentations.at(-1)!.paneId, 2, "resize reselects rather than restoring");
    assert.deepEqual(slots.map((slot) => slot.style.flexGrow), slotWeights);
    // A subsequent resize ack arriving after Restore cannot expand again.
    window.dispatchEvent(new window.Event("resize"));
    stateListener!({ ...resized, viewport: { ...resized.viewport, width: 900 }, geometryRevision: resized.geometryRevision + 1 });
    const obsoleteAck = acknowledgeResize;
    presentationResponse = null;
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    obsoleteAck({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selected.classList.contains("pane-popped-out"), false);
    assert.equal(selected.style.width, `${slots[1]!.getBoundingClientRect().width}px`, "Restore reads authoritative tiled slot geometry");
    assert.equal(selected.querySelector("webview"), liveHost);
    stateListener!(next);
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ownership = { surfaceId: next.surfaceId, surfaceEpoch: next.surfaceEpoch, revision: 100 };
    ownershipListener!({ ...ownership, phase: "blocked" });
    assert.equal(selected.classList.contains("pane-popped-out"), true, "pending retirement does not claim Restore");
    assert.equal(selected.querySelector(".pane-content")!.hasAttribute("inert"), true);
    assert.equal(toggle.hasAttribute("inert"), false);
    const uncertainSketch = selected.querySelector(".annotate");
    stateListener!({ ...next, connectionBar: "disconnected" });
    assert.notEqual(selected.querySelector(".annotate"), uncertainSketch, "uncertain state also rebuilds controls");
    assert.equal(selected.querySelector(".pane-pop-out"), toggle);
    assert.equal(toggle.closest("[inert]"), null, "recovery toggle remains reachable after uncertain rebuild");
    assert.ok(selected.querySelector(".annotate")!.closest("[inert]"), "uncertain rebuilt Sketch is shielded");
    assert.ok(selected.querySelector(".font-size-toggle")!.closest("[inert]"), "uncertain rebuilt Font is shielded");
    ownershipListener!({ ...ownership, phase: "cleared" });
    assert.equal(selected.classList.contains("pane-popped-out"), false);
    assert.equal(selected.querySelector("webview"), liveHost);
    assert.deepEqual(slots.map((slot) => slot.style.flexGrow), slotWeights);
    assert.equal(selected.querySelector(".annotate")!.closest("[inert]"), null, "confirmed recovery unshields new controls");
    stateListener!(next);
    ownershipListener!({ ...ownership, phase: "blocked" });
    assert.equal(selected.querySelector(".pane-content")!.hasAttribute("inert"), false,
      "late blocked notice cannot reverse confirmed clear");
    presentationResponse = async () => ({ ok: true, revision: 99 });
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selected.classList.contains("pane-popped-out"), false,
      "older main response cannot re-enter after confirmed ownership clear");
    presentationResponse = async () => ({ ok: true, revision: 101 });
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    ownershipListener!({ ...ownership, revision: 99, phase: "cleared" });
    ownershipListener!({ ...ownership, surfaceId: "foreign", revision: 200, phase: "cleared" });
    ownershipListener!({ ...ownership, surfaceEpoch: "old-epoch", revision: 200, phase: "cleared" });
    assert.equal(selected.classList.contains("pane-popped-out"), true, "stale or foreign clear cannot collapse a later presentation");
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    presentationResponse = null;
    assert.equal(liveHost.pageCounter, 12);
    assert.equal(roots[0]!.querySelector(".pane-content"), siblingContent);
    assert.equal(siblingContent.getAttribute("data-live-tick"), "2");
    assert.equal(JSON.stringify(next.layout), topologyBefore);
    assert.equal(commands.slice(commandsBefore).some((command) =>
      ["resize-split", "split-pane", "close-pane", "reload"].includes((command as { type: string }).type)), false);
    assert.equal(presentations.at(-1)!.paneId, null, "Restore is an acknowledged presentation request");
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selected.classList.contains("pane-popped-out"), true);
    presentationResponse = async () => ({ ok: false, presentationCleared: true, error: "host incarnation replaced" });
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selected.classList.contains("pane-popped-out"), false, "confirmed native retirement clears stale DOM mode");
    assert.equal(selected.querySelector("webview"), liveHost);
    assert.deepEqual(slots.map((slot) => slot.style.flexGrow), slotWeights);
    presentationResponse = null;
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    stateListener!({ ...next, panes: next.panes.map((pane) => pane.paneId === 2
      ? { ...pane, paneLineageId: "replacement-lineage" } : pane) });
    assert.equal(selected.classList.contains("pane-popped-out"), false, "same label with replaced lineage clears presentation");
    stateListener!(next);
    toggle.click();
    stateListener!({ ...next, topologyRevision: next.topologyRevision + 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selected.classList.contains("pane-popped-out"), false, "external topology epoch clears presentation");
    assert.equal(toggle.textContent, "");
    assert.equal(toggle.getAttribute("aria-label"), "Solo pane 2");
    toggle.click();
    stateListener!(state("connected"));
    assert.equal(document.querySelector(".pane-popped-out"), null, "closed selected pane cannot be restored");
    assert.equal(document.querySelector(".pane-slot")?.getAttribute("inert"), null);

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

  await test("completed loading restores zoom without dom-ready and fences obsolete readiness probes", async () => {
    const next = state("connected", true);
    for (const [index, pane] of next.panes.entries()) Object.assign(pane.content, {
      content: { url: `https://fixture.invalid/readiness-${index}` }, contentType: "browser_url",
      contentId: `readiness-${index}`, revision: 45, renderVersion: 45,
    });
    stateListener!(next);
    const guests = [...document.querySelectorAll("webview")] as Array<HTMLElement & {
      executeJavaScript: (code: string) => Promise<unknown>;
    }>;
    const scripts = guests.map(() => [] as string[]);
    let probe: Promise<unknown> = Promise.resolve("complete");
    guests.forEach((guest, index) => {
      guest.executeJavaScript = async (code) => {
        if (code === "document.readyState") return probe;
        if (code.includes("document.documentElement.style.zoom")) scripts[index]!.push(code);
        return null;
      };
      guest.dispatchEvent(new window.Event("dom-ready"));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const guest = guests[0]!;
    keyboardListener!({ action: "reset", paneId: 1, type: "content-scale" });
    const siblingScripts = scripts[1]!.length;
    guest.dispatchEvent(new window.Event("did-start-loading"));
    const prior = scripts[0]!.length;
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    assert.equal(scripts[0]!.length, prior, "a loading guest defers the latest zoom intent");
    guest.dispatchEvent(new window.Event("did-stop-loading"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(guest.dataset.guestReady, "true");
    assert.ok(scripts[0]!.at(-1)!.includes("0.935"), "completed retained document receives latest zoom");
    assert.equal(scripts[1]!.length, siblingScripts, "sibling guest remains untouched");
    assert.deepEqual([...document.querySelectorAll("webview")], guests);

    let finishOldProbe!: (value: unknown) => void;
    probe = new Promise((resolve) => { finishOldProbe = resolve; });
    guest.dispatchEvent(new window.Event("did-start-loading"));
    guest.dispatchEvent(new window.Event("did-stop-loading"));
    guest.dispatchEvent(new window.Event("did-start-loading"));
    const beforeStaleProbe = scripts[0]!.length;
    finishOldProbe("complete");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(guest.dataset.guestReady, undefined, "old completion cannot ready a newer navigation");
    assert.equal(scripts[0]!.length, beforeStaleProbe);
    probe = Promise.resolve("loading");
    guest.dispatchEvent(new window.Event("did-stop-loading"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(guest.dataset.guestReady, undefined, "spinner stop alone is not readiness proof");

    let finishDetachedProbe!: (value: unknown) => void;
    probe = new Promise((resolve) => { finishDetachedProbe = resolve; });
    guest.dispatchEvent(new window.Event("did-stop-loading"));
    stateListener!(state("connected", true));
    finishDetachedProbe("complete");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(guest.dataset.guestReady, undefined, "retired content cannot recover readiness");
    assert.equal(scripts[0]!.length, beforeStaleProbe);
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

  await test("actual queued-authority receipts keep input blocked in both delivery orders", async () => {
    // Advance the real coordinator past earlier ownership fixtures (revision101).
    const cases = await queuedAuthorityRace(2, 102);
    for (const [index, receipts] of cases.entries()) {
      const next = state("connected", true);
      stateListener!(next);
      const root = document.querySelectorAll<HTMLElement>(".pane-shell")[1]!;
      const guest = root.querySelector("webview");
      const toggle = root.querySelector<HTMLButtonElement>(".pane-pop-out")!;
      const handle = document.querySelector<HTMLElement>(".split-resize-handle")!;
      Object.assign(handle, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
      let commits = 0;
      Object.assign(surfAce, { async resizeSplit() { commits++; return true; } });
      const pointer = (type: string) => {
        const event = new window.Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { pointerId: 92, clientX: 140, clientY: 140 });
        (type === "pointerdown" ? handle : window).dispatchEvent(event);
        return event;
      };
      type Outcome = typeof receipts.clear;
      const releases: Array<(outcome: Outcome) => void> = [];
      presentationResponse = () => new Promise((resolve) => { releases.push(resolve); });
      toggle.click(); // A held; a second click registers B without changing display.
      toggle.click();
      assert.equal(releases.length, 2);
      const order = index === 0 ? [0, 1] : [1, 0];
      for (const reply of order) {
        releases[reply]!(reply === 0 ? receipts.clear : receipts.blocked);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(pointer("pointerdown").defaultPrevented, false);
        assert.equal(root.querySelector(".pane-content")!.hasAttribute("inert"), true,
          "A clear cannot certify B, in either IPC delivery order");
      }
      pointer("pointermove"); pointer("pointerup");
      assert.equal(commits, 0);
      assert.equal(root.classList.contains("pane-popped-out"), false);
      assert.equal(root.querySelector("webview"), guest);
      // The real coordinator's later matched Restore is the recovery fence.
      toggle.click();
      releases[2]!(receipts.recovery);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(root.querySelector(".pane-content")!.hasAttribute("inert"), false);
      assert.equal(pointer("pointerdown").defaultPrevented, true);
      pointer("pointercancel");
      presentationResponse = null;
      // Recovery response is a clear, not an enter acknowledgement.
      if (root.classList.contains("pane-popped-out")) {
        toggle.click(); await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  });

  await test("delayed presentation ack and retirement exclude divider commits and preserve tiled geometry", async () => {
    focusStateUpdate = null;
    const next = state("connected", true);
    stateListener!(next);
    const roots = [...document.querySelectorAll<HTMLElement>(".pane-shell")];
    const slots = [...document.querySelectorAll<HTMLElement>(".pane-layout-slot")];
    const toggle = roots[1]!.querySelector<HTMLButtonElement>(".pane-pop-out")!;
    const commits: Array<any> = [];
    let finishResize!: (value: boolean) => void;
    Object.assign(surfAce, { resizeSplit(payload: unknown) {
      commits.push(payload);
      return new Promise<boolean>((resolve) => { finishResize = resolve; });
    } });
    let finishPresentation!: (response: { ok: boolean; presentationBlocked?: boolean; presentationCleared?: boolean }) => void;
    presentationResponse = () => new Promise((resolve) => { finishPresentation = resolve; });
    const handle = document.querySelector<HTMLElement>(".split-resize-handle")!;
    Object.assign(handle, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
    const pointer = (target: EventTarget, type: string, x: number) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 90, clientX: x, clientY: x });
      target.dispatchEvent(event);
      return event;
    };
    const layoutBefore = JSON.stringify(next.layout);
    const commandsBefore = commands.length;
    toggle.click();
    assert.equal(pointer(handle, "pointerdown", 100).defaultPrevented, false, "pending enter rejects divider admission");
    pointer(window, "pointermove", 140);
    assert.equal(roots[0]!.querySelector(".pane-content")!.hasAttribute("inert"), true);
    finishPresentation({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    pointer(window, "pointerup", 140);
    assert.equal(roots[1]!.classList.contains("pane-popped-out"), true);
    assert.equal(commits.length, 0, "late enter acknowledgement cannot turn the release into mixed durable geometry");
    assert.equal(JSON.stringify(next.layout), layoutBefore);
    assert.equal(commands.slice(commandsBefore).some((c) => ["resize-split", "split-pane", "close-pane"].includes((c as any).type)), false);
    toggle.click();
    assert.equal(pointer(handle, "pointerdown", 100).defaultPrevented, false, "pending retirement excludes divider admission");
    finishPresentation({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Existing held gestures are canceled before an enter can be sent.
    assert.equal(pointer(handle, "pointerdown", 100).defaultPrevented, true);
    pointer(window, "pointermove", 140);
    toggle.click();
    finishPresentation({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    pointer(window, "pointerup", 140);
    assert.equal(commits.length, 0, "cancel-before-enter removes the held release listener");
    toggle.click();
    finishPresentation({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // A candidate comes from tiled slots even if content-host measurements
    // resemble a display overlay. Root bounds are never resize authority.
    Object.defineProperty(roots[1]!, "getBoundingClientRect", { configurable: true,
      value: () => ({ x: 16, y: 16, left: 16, top: 16, width: 1168, height: 768, right: 1184, bottom: 784 }) });
    pointer(handle, "pointerdown", 100);
    pointer(window, "pointerup", 140);
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].geometry, slots.map((slot, i) => {
      const rect = slot.getBoundingClientRect();
      return { paneId: next.panes[i]!.paneId, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    }));
    const requestsBefore = presentations.length;
    toggle.click();
    assert.equal(presentations.length, requestsBefore, "pending divider commit cannot admit an enter with a late ack");
    assert.match(toggle.title, /divider resize/);
    finishResize(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    delete (roots[1] as any).getBoundingClientRect;
    toggle.click();
    finishPresentation({ ok: false, presentationBlocked: true, presentationCleared: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pointer(handle, "pointerdown", 100).defaultPrevented, false,
      "unretired native outcome continues to block durable resize after the reply");
    presentationResponse = null;
    toggle.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pointer(handle, "pointerdown", 100).defaultPrevented, true, "confirmed retirement restores divider admission");
    pointer(window, "pointercancel", 100);
    assert.equal(commits.length, 1);
  });

  await test("stale enter failure retains native authority until revision-fenced retirement", async () => {
    const next = state("connected", true);
    stateListener!(next);
    const root = document.querySelectorAll<HTMLElement>(".pane-shell")[1]!;
    const guest = root.querySelector("webview");
    const toggle = root.querySelector<HTMLButtonElement>(".pane-pop-out")!;
    const handle = document.querySelector<HTMLElement>(".split-resize-handle")!;
    Object.assign(handle, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
    let reports = 0;
    let commits = 0;
    const oldSnapshot = surfAce.reportSnapshot;
    const oldOverlay = surfAce.reportOverlayRegions;
    Object.assign(surfAce, { reportSnapshot() { reports++; }, reportOverlayRegions() { reports++; },
      async resizeSplit() { commits++; return true; } });
    const pointer = (type: string) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 91, clientX: 140, clientY: 140 });
      (type === "pointerdown" ? handle : window).dispatchEvent(event);
      return event;
    };
    let finish!: (response: { ok: boolean; authorityRevision: number; presentationBlocked?: boolean; presentationCleared?: boolean }) => void;
    presentationResponse = () => new Promise((resolve) => { finish = resolve; });
    toggle.click();
    const changed = { ...next, geometryRevision: next.geometryRevision + 1,
      viewport: { ...next.viewport, width: 1000 } };
    stateListener!(changed);
    const reportsBefore = reports;
    finish({ ok: false, authorityRevision: 200, presentationBlocked: true, presentationCleared: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(root.classList.contains("pane-popped-out"), false, "stale reply cannot apply display pixels");
    assert.equal(root.querySelector(".pane-content")!.hasAttribute("inert"), true,
      "failed native retirement survives stale geometry and finally");
    assert.equal(pointer("pointerdown").defaultPrevented, false);
    pointer("pointermove"); pointer("pointerup");
    assert.equal(commits, 0);
    assert.equal(reports, reportsBefore, "unresolved authority cannot publish tiled snapshots or overlay regions");
    assert.equal(root.querySelector("webview"), guest);
    assert.deepEqual(changed.layout, next.layout);
    // An obsolete clear cannot reopen input. A current confirmed retirement can.
    toggle.click();
    finish({ ok: false, authorityRevision: 199, presentationCleared: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pointer("pointerdown").defaultPrevented, false);
    toggle.click();
    finish({ ok: false, authorityRevision: 201, presentationCleared: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(root.querySelector(".pane-content")!.hasAttribute("inert"), false);
    assert.equal(pointer("pointerdown").defaultPrevented, true);
    pointer("pointercancel");
    // A late blocked reply must not undo a newer independently confirmed clear.
    toggle.click();
    stateListener!({ ...changed, geometryRevision: changed.geometryRevision + 1 });
    ownershipListener!({ surfaceId: next.surfaceId, surfaceEpoch: next.surfaceEpoch, revision: 203, authorityRevision: 203, phase: "cleared" });
    finish({ ok: false, authorityRevision: 202, presentationBlocked: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(root.querySelector(".pane-content")!.hasAttribute("inert"), false);
    assert.equal(pointer("pointerdown").defaultPrevented, true);
    pointer("pointercancel");
    assert.equal(commits, 0);
    presentationResponse = null;
    Object.assign(surfAce, { reportSnapshot: oldSnapshot, reportOverlayRegions: oldOverlay });
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
