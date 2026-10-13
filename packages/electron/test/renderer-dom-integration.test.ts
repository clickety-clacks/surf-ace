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
  let stateListener: ((next: unknown) => void) | null = null;
  let keyboardListener: ((intent: unknown) => void) | null = null;
  let focusStateUpdate: (() => void) | null = null;
  let provenanceWidth = 200;
  let nonceCounter = 0;
  let textMetricScale = 1;
  const commands: unknown[] = [];
  let finishCalls = 0;
  let finishReply!: (state: { phase: string; busy: boolean; localSaved: boolean }) => void;
  const resizeCallbacks: Array<() => void> = [];
  const mutationCallbacks: Array<() => void> = [];
  const fontCallbacks: Array<() => void> = [];
  const surfAce = {
    finishAnnotation() {
      finishCalls++;
      return new Promise((resolve) => { finishReply = resolve; });
    },
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
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: { getRandomValues(bytes: Uint8Array) { bytes.fill(++nonceCounter); return bytes; } },
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

  // Hold the actual internal completion response through a real chrome rebuild.
  // Replaced controls must retain the fence, and an old button must not submit twice.
  stateListener!(state("connected", true, 1));
  const oldDone = document.querySelector(".done") as HTMLButtonElement;
  const annotationIntent = (action: string, expected = { paneId: 1, paneLineageId: "lineage-1", contentId: "content-1", revision: 1, renderVersion: 1 }) =>
    keyboardListener!({ type: "annotation", action, expected });
  annotationIntent("done", { paneId: 1, paneLineageId: "old-lineage", contentId: "content-1", revision: 1, renderVersion: 1 });
  assert.equal(finishCalls, 0, "stale keyboard context cannot finish a replacement");
  annotationIntent("done");
  assert.equal((document.querySelector(".done") as HTMLButtonElement).disabled, true);
  assert.equal(document.querySelector(".done")!.getAttribute("aria-busy"), "true");
  oldDone.click();
  const heldCommandCount = commands.length;
  annotationIntent("enter"); annotationIntent("done"); annotationIntent("done");
  assert.equal(commands.length, heldCommandCount, "keyboard A cannot re-enter around held renderer Done");
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(finishCalls, 1);
  stateListener!(state("disconnected", true, 1));
  const rebuiltDone = document.querySelector(".done") as HTMLButtonElement;
  assert.notEqual(rebuiltDone, oldDone);
  assert.equal(rebuiltDone.disabled, true);
  assert.equal((document.querySelector(".annotate") as HTMLButtonElement).disabled, true);
  rebuiltDone.click();
  assert.equal(finishCalls, 1);
  stateListener!(state("connected", true)); // local save can exit Sketch before delivery settles
  assert.equal((document.querySelector(".done") as HTMLButtonElement).disabled, true);
  finishReply({ phase: "saved", busy: false, localSaved: true });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(document.querySelector(".done"), null);
  assert.equal(document.querySelector(".annotation-local-status")?.textContent, "Saved locally");
  // Delivery-only changes must update chrome without changing content/geometry.
  // These restored internal receipts explicitly remain registry acceptance,
  // never consumer processed acknowledgement.
  for (const [phase, label] of [
    ["waiting", "Saved locally · Waiting"], ["sending", "Saved locally · Sending"],
    ["sent", "Sent to registry"], ["rejected", "Saved locally · Registry rejected this record"],
  ]) {
    const next = state("connected", true);
    (next.panes[0] as any).annotationDelivery = { phase };
    stateListener!(next);
    assert.equal(document.querySelector(".annotation-local-status")?.textContent, label);
    assert.equal(document.querySelector(".annotation-local-status")?.textContent?.includes("processed"), false);
  }
  stateListener!(state("connected", true));

  annotationIntent("enter");
  assert.equal((commands.at(-1) as any).type, "annotate");
  assert.equal((commands.at(-1) as any).enabled, true);
  stateListener!(state("connected", true, 1));
  assert.equal(document.querySelector(".annotation-local-status"), null,
    "a new Sketch session cannot reuse the last completed local Saved status");
  stateListener!(state("connected", true));

  stateListener!(state("connected", true, 1));
  annotationIntent("done");
  for (let i = 0; i < 4; i++) await Promise.resolve();
  finishReply({ phase: "unknown", busy: false, localSaved: false });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.match(document.querySelector(".annotation-local-status")!.textContent!, /Save outcome unknown/);
  annotationIntent("enter");
  stateListener!(state("connected", true, 1));
  annotationIntent("done");
  for (let i = 0; i < 4; i++) await Promise.resolve();
  finishReply({ phase: "waiting", busy: false, localSaved: true });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(document.querySelector(".annotation-local-status")!.textContent, "Saved locally · Waiting");
  annotationIntent("enter");
  stateListener!(state("connected", true));

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
      assert.ok(scripts.some((script) => script.includes("surf-ace.public-terminal-font-scale.v2")),
        "scale initialization still runs after dom-ready");
      const firstScales = scripts.filter((script) => script.includes("surf-ace.public-terminal-font-scale.v2")).length;
      webview.dispatchEvent(new window.Event("did-start-loading"));
      webview.dispatchEvent(new window.Event("dom-ready"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(scripts.filter((script) => script.includes("surf-ace.public-terminal-font-scale.v2")).length > firstScales,
        "navigation reapplies scale after the next dom-ready");
    }
  });

  await test("generic page host scale changes only the ready guest without document zoom or remount", async () => {
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
      const result = { resizeEvents: 0 };
      return {
        document: { documentElement: root, body: { style: { setProperty() {} } } },
        CustomEvent: class { constructor(public type: string, public init?: { detail?: unknown }) {} },
        MutationObserver: class { constructor() {} observe() {} disconnect() {} },
        Event: class { constructor(public type: string) {} },
        setTimeout: () => 1, clearTimeout: () => {},
        window: { dispatchEvent(event: { type: string }) {
          if (event.type === "resize") {
            result.resizeEvents++;
          }
        } }, result,
      };
    });
    const scripts = guests.map(() => [] as string[]);
    let deferNextModeResult = false;
    let heldModeResult: { resolve: (value: unknown) => void; value: unknown } | null = null;
    guests.forEach((guest, index) => {
      guest.executeJavaScript = async (code) => {
        if (code.includes("surf-ace.public-terminal-font-scale.v2")) {
          scripts[index]!.push(code);
          const value = runInNewContext(code, contexts[index]);
          if (index === 0 && deferNextModeResult) {
            deferNextModeResult = false;
            return new Promise((resolve) => { heldModeResult = { resolve, value }; });
          }
          return value;
        }
        return null;
      };
      guest.dispatchEvent(new window.Event("dom-ready"));
    });
    const identity = (code: string) => {
      const nonce = code.match(/c\.hostNonce = ("[^"]*")/)?.[1];
      const revision = code.match(/c\.hostRevision = (\d+)/)?.[1];
      assert.ok(nonce && revision, "scale script carries its current nonce and revision");
      return { nonce: JSON.parse(nonce) as string, revision: Number(revision) };
    };
    const sendMode = (
      guest: HTMLElement,
      mode: "host-transform" | "public-terminal-font",
      stamp: { nonce: string; revision: number },
      sequence: number,
    ) => {
      const event = new window.Event("ipc-message");
      Object.assign(event, { channel: "surf-ace-content", args: [{ type: "scale-mode", mode, sequence, ...stamp }] });
      guest.dispatchEvent(event);
    };
    await new Promise((resolve) => setTimeout(resolve, 0));
    const initialWidth = Number.parseFloat(guests[0]!.style.width);
    assert.equal(guests[0]!.style.transform, "scale(0.85)");
    assert.equal(guests[0]!.style.transformOrigin, "0 0");
    assert.ok(Math.abs(initialWidth * 0.85 - guests[0]!.getBoundingClientRect().width) < 0.01);
    assert.equal(contexts[0]!.document.documentElement.style.zoom, "");
    const otherEvents = contexts[1]!.result.resizeEvents;
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    assert.equal(guests[0]!.style.transform, "scale(0.935)");
    assert.ok(Math.abs(Number.parseFloat(guests[0]!.style.width) * 0.935 - guests[0]!.getBoundingClientRect().width) < 0.01);
    assert.equal(guests[1]!.style.transform, "scale(0.85)");
    assert.equal(contexts[0]!.document.documentElement.style.zoom, "");
    assert.equal(contexts[1]!.result.resizeEvents, otherEvents);
    assert.deepEqual([...document.querySelectorAll("webview")], guests);
    const firstIdentity = identity(scripts[0]![0]!);
    const currentIdentity = identity(scripts[0]!.at(-1)!);
    sendMode(guests[0]!, "public-terminal-font", firstIdentity, 2);
    assert.equal(guests[0]!.style.transform, "scale(0.935)", "obsolete mode event cannot undo a newer host scale");
    guests[0]!.dispatchEvent(new window.Event("did-start-loading"));
    const prior = contexts[0]!.result.resizeEvents;
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    assert.equal(contexts[0]!.result.resizeEvents, prior, "loading guest cannot run scale methods");
    assert.equal(guests[0]!.style.transform, "", "unknown loading document waits for its mode before host scaling");
    guests[0]!.dispatchEvent(new window.Event("dom-ready"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(guests[0]!.style.transform, "scale(1.02)");
    assert.equal(contexts[0]!.document.documentElement.style.zoom, "");
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    deferNextModeResult = true;
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const enlargedScale = 1.275;
    assert.equal(guests[0]!.style.transform, `scale(${enlargedScale})`);
    assert.ok(Math.abs(Number.parseFloat(guests[0]!.style.width) * enlargedScale - guests[0]!.getBoundingClientRect().width) < 0.01);
    assert.ok(Math.abs(Number.parseFloat(guests[0]!.style.minHeight) * enlargedScale - guests[0]!.getBoundingClientRect().height) < 0.01);
    const delayedIdentity = identity(scripts[0]!.at(-1)!);
    assert.notEqual(delayedIdentity.nonce, currentIdentity.nonce);
    assert.ok(heldModeResult, "initial mode result is held until a newer same-request IPC observation arrives");
    sendMode(guests[0]!, "public-terminal-font", delayedIdentity, 2);
    assert.equal(guests[0]!.style.transform, "", "newer terminal observation removes the host transform");
    heldModeResult!.resolve(heldModeResult!.value);
    heldModeResult = null;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(guests[0]!.style.transform, "", "late host-transform result cannot roll back a newer terminal observation");
    sendMode(guests[0]!, "host-transform", delayedIdentity, 2);
    assert.equal(guests[0]!.style.transform, "", "a duplicate observation cannot switch modes at the same sequence");
    sendMode(guests[0]!, "public-terminal-font", currentIdentity, 2);
    assert.equal(guests[0]!.style.transform, "", "old revision cannot affect the delayed current mode");
    sendMode(guests[0]!, "host-transform", delayedIdentity, 3);
    assert.equal(guests[0]!.style.transform, `scale(${enlargedScale})`, "newer generic observation restores the host transform");

    deferNextModeResult = true;
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const supersededResult = heldModeResult;
    assert.ok(supersededResult, "a pending initial result is retained across a newer scale request");
    const supersededIdentity = identity(scripts[0]!.at(-1)!);
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const latestTransform = guests[0]!.style.transform;
    supersededResult!.resolve(supersededResult!.value);
    heldModeResult = null;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(guests[0]!.style.transform, latestTransform, "a result from a superseded scale request cannot affect the current request");
    sendMode(guests[0]!, "public-terminal-font", supersededIdentity, 2);
    assert.equal(guests[0]!.style.transform, latestTransform, "an IPC observation from a superseded request remains fenced");

    deferNextModeResult = true;
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const navigationResult = heldModeResult;
    assert.ok(navigationResult, "navigation fixture holds the initial result before it resolves");
    guests[0]!.dispatchEvent(new window.Event("did-start-loading"));
    assert.equal(guests[0]!.style.transform, "", "navigation reset retires the old host transform");
    navigationResult!.resolve(navigationResult!.value);
    heldModeResult = null;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(guests[0]!.style.transform, "", "a pending result from the prior document cannot restore its transform after navigation");
  });

  await test("ready public terminal scales its font at unit document zoom and retains guest", async () => {
    const next = state("connected");
    Object.assign(next.panes[0]!.content, {
      content: { url: "https://fixture.invalid/public-terminal" }, contentType: "browser_url",
      contentId: "public-terminal", revision: 44, renderVersion: 44,
    });
    stateListener!(next);
    const guest = document.querySelector("webview") as HTMLElement & {
      executeJavaScript: (code: string) => Promise<unknown>;
    };
    const root = { style: { zoom: "" } };
    const guestDocument = {
      documentElement: root, body: { style: { setProperty() {} } },
      querySelectorAll: () => [element],
    };
    class GuestElement {
      isConnected = true;
      ownerDocument = guestDocument;
      matches(selector: string) { return selector === ".xterm"; }
      querySelector(selector: string) { return selector === ".xterm-screen" ? {} : null; }
    }
    const element = new GuestElement();
    const fits: number[] = [];
    const term = {
      element, options: { fontSize: 16 },
      fit() { fits.push(this.options.fontSize); },
      onRender() { return { dispose() {} }; },
    };
    const context = {
      document: guestDocument, HTMLElement: GuestElement,
      window: { term, dispatchEvent() {} },
      CustomEvent: class { constructor(public type: string, public init?: { detail?: unknown }) {} },
      MutationObserver: class { constructor() {} observe() {} disconnect() {} },
      requestAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
      Event: class { constructor(public type: string) {} },
    };
    const modes: string[] = [];
    const modeSequences: number[] = [];
    const scripts: string[] = [];
    let deferInitialModeResult = true;
    let heldInitialModeResult: { resolve: (value: unknown) => void; value: unknown } | null = null;
    const scaleIdentity = (code: string) => {
      const nonce = code.match(/c\.hostNonce = ("[^"]*")/)?.[1];
      const revision = code.match(/c\.hostRevision = (\d+)/)?.[1];
      assert.ok(nonce && revision, "scale script carries its current nonce and revision");
      return { nonce: JSON.parse(nonce) as string, revision: Number(revision) };
    };
    const sendMode = (
      mode: "host-transform" | "public-terminal-font",
      stamp: { nonce: string; revision: number },
      sequence: number,
    ) => {
      const event = new window.Event("ipc-message");
      Object.assign(event, { channel: "surf-ace-content", args: [{ type: "scale-mode", mode, sequence, ...stamp }] });
      guest.dispatchEvent(event);
    };
    guest.executeJavaScript = async (code) => {
      if (code === "document.readyState") return "complete";
      if (code.includes("surf-ace.public-terminal-font-scale.v2")) {
        scripts.push(code);
        const result = runInNewContext(code, context);
        modes.push(result.mode);
        modeSequences.push(result.sequence);
        if (deferInitialModeResult) {
          deferInitialModeResult = false;
          return new Promise((resolve) => { heldInitialModeResult = { resolve, value: result }; });
        }
        return result;
      }
      return null;
    };
    keyboardListener!({ action: "reset", paneId: 1, type: "content-scale" });
    guest.dispatchEvent(new window.Event("did-attach"));
    assert.equal(fits.length, 0, "attach cannot scale an unready public terminal");
    guest.dispatchEvent(new window.Event("dom-ready"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(heldInitialModeResult, "initial public-terminal result is held for the ordering check");
    const initialIdentity = scaleIdentity(scripts[0]!);
    sendMode("host-transform", initialIdentity, 2);
    assert.equal(guest.style.transform, "scale(0.85)", "newer host observation applies while terminal result is pending");
    heldInitialModeResult!.resolve(heldInitialModeResult!.value);
    heldInitialModeResult = null;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(guest.style.transform, "scale(0.85)", "late public-terminal result cannot roll back a newer host observation");
    sendMode("public-terminal-font", initialIdentity, 3);
    assert.equal(guest.style.transform, "", "newer terminal observation restores physical guest bounds");
    assert.equal(term.options.fontSize, 13.6);
    assert.equal(root.style.zoom, "", "terminal font scaling must not also scale its document");
    const terminalWidth = guest.style.width;
    assert.equal(guest.style.transform, "", "public terminal keeps physical webview bounds without a second host scale");
    assert.equal(guest.style.minWidth, terminalWidth);
    keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
    assert.equal(term.options.fontSize, 14.96);
    assert.equal(root.style.zoom, "");
    assert.equal(guest.style.transform, "", "terminal fit owns its scale while host bounds remain physical");
    assert.equal(guest.style.width, terminalWidth);
    keyboardListener!({ action: "reset", paneId: 1, type: "content-scale" });
    assert.equal(term.options.fontSize, 13.6);
    assert.deepEqual(fits, [13.6, 14.96, 13.6]);
    assert.deepEqual(modes, ["public-terminal-font", "public-terminal-font", "public-terminal-font"]);
    assert.deepEqual(modeSequences, [1, 1, 1], "each new scale request starts a fresh ordered observation sequence");
    assert.equal(scripts.length, 3);
    assert.equal(document.querySelector("webview"), guest);
    assert.equal(context.window.term, term);
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
        if (code.includes("surf-ace.public-terminal-font-scale.v2")) scripts[index]!.push(code);
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

  // Pane33: same-byte duplicate preservation must not outrank an absent owned guest.
  window.requestAnimationFrame = (callback: FrameRequestCallback) => { callback(0); return 1; };
  let duplicateSequence = 1000;
  const duplicateFixture = () => {
    const next = state("connected", true);
    for (const [index, p] of next.panes.entries()) {
      Object.assign(p.content, {
        content: { html: `<html><body>guest ${index} fixture ${++duplicateSequence}</body></html>` },
        contentType: "html", contentId: `duplicate-${duplicateSequence}`, revision: duplicateSequence, renderVersion: duplicateSequence,
      });
    }
    stateListener!(next);
    const roots = [...document.querySelectorAll(".pane-shell")] as HTMLElement[];
    const guests = roots.map(root => root.querySelector("webview")!) as Array<HTMLElement & {
      src?: string; getWebContentsId?: () => number; sessionMarker?: object;
    }>;
    assert.equal(guests.length, 2);
    for (const [index, guest] of guests.entries()) {
      guest.getWebContentsId = () => 501 + index;
      guest.sessionMarker = { session: `retained-${index}`, history: ["first", "second"] };
    }
    return { next, roots, guests };
  };
  const repush = (next: ReturnType<typeof state>, html?: string) => {
    const changed = structuredClone(next);
    const p = changed.panes[0]!;
    p.content.revision = ++duplicateSequence;
    p.content.renderVersion = duplicateSequence;
    p.content.contentId = `duplicate-${duplicateSequence}`;
    if (html !== undefined) Object.assign(p.content, { content: { html } });
    stateListener!(changed);
    return changed;
  };
  await test("healthy HTML duplicate keeps owned DOM guest, session and siblings", () => {
    const f = duplicateFixture();
    const siblingSession = f.guests[1]!.sessionMarker;
    const firstSession = f.guests[0]!.sessionMarker;
    const src = f.guests[0]!.src;
    const beforeCommands = commands.length;
    const next = repush(f.next);
    assert.equal(document.querySelectorAll(".pane-shell")[0], f.roots[0]);
    assert.equal(f.roots[0]!.querySelector("webview"), f.guests[0]);
    assert.equal(f.guests[0]!.sessionMarker, firstSession);
    assert.equal(f.guests[0]!.getWebContentsId?.(), 501);
    assert.equal(f.guests[0]!.src, src);
    assert.equal(f.roots[1]!.querySelector("webview"), f.guests[1]);
    assert.equal(f.guests[1]!.sessionMarker, siblingSession);
    assert.deepEqual(next.layout, f.next.layout);
    assert.deepEqual(next.panes[1], f.next.panes[1]);
    assert.deepEqual(commands.slice(beforeCommands), [], "no authority/history mutation command is introduced");
  });
  await test("absent owned guest repush runs normal render in same pane host", () => {
    const f = duplicateFixture();
    const host = f.roots[0]!.querySelector(".pane-content")!;
    host.replaceChildren();
    const next = repush(f.next);
    const restored = host.querySelector("webview") as HTMLElement & { src?: string };
    assert.ok(restored);
    assert.notEqual(restored, f.guests[0]);
    assert.equal(restored.isConnected, true);
    assert.equal(document.querySelectorAll(".pane-shell")[0], f.roots[0]);
    assert.equal(restored.src, f.guests[0]!.src);
    assert.equal(f.roots[1]!.querySelector("webview"), f.guests[1]);
    assert.deepEqual(next.layout, f.next.layout);
    assert.deepEqual(next.panes[1], f.next.panes[1]);
  });
  await test("detached retained guest is replaced only for the fresh target key", () => {
    const f = duplicateFixture(), detached = document.createElement("div");
    detached.appendChild(f.guests[0]!);
    assert.equal(f.guests[0]!.isConnected, false);
    repush(f.next);
    const restored = f.roots[0]!.querySelector("webview")!;
    assert.ok(restored); assert.notEqual(restored, f.guests[0]);
    assert.equal(detached.firstChild, f.guests[0], "retired node is not borrowed into the fresh pane");
    assert.equal(f.roots[1]!.querySelector("webview"), f.guests[1]);
  });
  await test("foreign unowned frame cannot borrow duplicate signature", () => {
    const f = duplicateFixture(), host = f.roots[0]!.querySelector(".pane-content")!;
    const foreign = f.guests[0]!.cloneNode(true) as HTMLElement;
    host.replaceChildren(foreign);
    assert.equal(foreign.isConnected, true);
    repush(f.next);
    const restored = host.querySelector("webview")!;
    assert.ok(restored); assert.ok(restored !== foreign, "unowned replacement cannot be retained"); assert.notEqual(restored, f.guests[0]);
    assert.equal(foreign.isConnected, false);
    assert.equal(f.roots[1]!.querySelector("webview"), f.guests[1]);
  });
  await test("unchanged authoritative key with missing guest remains no-op", () => {
    const f = duplicateFixture(), host = f.roots[0]!.querySelector(".pane-content")!;
    host.replaceChildren();
    const churn = structuredClone(f.next);
    churn.connectionBar = "connecting";
    stateListener!(churn);
    assert.equal(host.querySelector("webview"), null);
    assert.equal(f.roots[1]!.querySelector("webview"), f.guests[1]);
  });
  await test("changed HTML creates a fresh guest without changing sibling session", () => {
    const f = duplicateFixture(), siblingSession = f.guests[1]!.sessionMarker;
    repush(f.next, "<html><body>changed exact content</body></html>");
    const changed = f.roots[0]!.querySelector("webview") as HTMLElement & { src?: string };
    assert.notEqual(changed, f.guests[0]);
    assert.ok(changed.src?.includes(encodeURIComponent("changed exact content")));
    assert.equal(f.roots[1]!.querySelector("webview"), f.guests[1]);
    assert.equal(f.guests[1]!.sessionMarker, siblingSession);
  });
  await test("connected loading and unmeasured white guest are not classified dead", () => {
    const f = duplicateFixture();
    f.guests[0]!.dispatchEvent(new window.Event("did-start-loading"));
    delete f.guests[0]!.dataset.guestReady;
    f.guests[0]!.getWebContentsId = () => { throw new Error("guest temporarily unavailable"); };
    repush(f.next);
    assert.equal(f.roots[0]!.querySelector("webview"), f.guests[0]);
    assert.equal(f.roots[1]!.querySelector("webview"), f.guests[1]);
  });
  await test("old deferred navigation cannot overwrite recovered or newer content", () => {
    const f = duplicateFixture();
    const queued: FrameRequestCallback[] = [];
    const immediate = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => { queued.push(callback); return queued.length; };
    try {
      const pending = repush(f.next, "<html><body>held navigation</body></html>");
      const old = f.roots[0]!.querySelector("webview") as HTMLElement & { src?: string };
      assert.equal(old.src, undefined);
      old.remove();
      const recoveredState = repush(pending);
      const recovered = f.roots[0]!.querySelector("webview") as HTMLElement & { src?: string };
      assert.notEqual(recovered, old);
      const newestState = repush(recoveredState, "<html><body>newest navigation</body></html>");
      const newest = f.roots[0]!.querySelector("webview") as HTMLElement & { src?: string };
      assert.notEqual(newest, recovered);
      let count = 0;
      while (queued.length) { assert.ok(++count < 100); queued.shift()!(0); }
      assert.equal(old.src, undefined);
      assert.equal(recovered.src, undefined);
      assert.ok(newest.src?.includes(encodeURIComponent("newest navigation")));
      assert.equal(f.roots[1]!.querySelector("webview"), f.guests[1]);
      assert.deepEqual(newestState.panes[1], f.next.panes[1]);
    } finally { window.requestAnimationFrame = immediate; queued.length = 0; }
  });
  await test("duplicate during pending initial navigation retains original assignment and session", () => {
    const f = duplicateFixture();
    const queued: FrameRequestCallback[] = [];
    const immediate = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => { queued.push(callback); return queued.length; };
    try {
      const pending = repush(f.next, "<html><body>pending healthy navigation</body></html>");
      const guest = f.roots[0]!.querySelector("webview") as HTMLElement & { src?: string; sessionMarker?: object };
      guest.sessionMarker = { history: ["retained before ready"] };
      const session = guest.sessionMarker;
      repush(pending);
      assert.equal(f.roots[0]!.querySelector("webview"), guest);
      assert.equal(guest.src, undefined);
      let count = 0;
      while (queued.length) { assert.ok(++count < 100); queued.shift()!(0); }
      assert.ok(String(guest.src).includes(encodeURIComponent("pending healthy navigation")));
      assert.equal(guest.sessionMarker, session);
      assert.equal(f.roots[1]!.querySelector("webview"), f.guests[1]);
    } finally { window.requestAnimationFrame = immediate; queued.length = 0; }
  });

  await test("browser URL duplicate preserves its own frame while absent URL frame renders normally", () => {
    const f = duplicateFixture();
    const browserState = structuredClone(f.next);
    Object.assign(browserState.panes[0]!.content, { contentType: "browser_url", content: { url: "https://example.invalid/isolated-dom-only" }, revision: ++duplicateSequence, renderVersion: duplicateSequence });
    stateListener!(browserState);
    const browser = f.roots[0]!.querySelector("webview") as HTMLElement & { src?: string; sessionMarker?: object };
    browser.sessionMarker = { history: ["url history retained"] };
    const session = browser.sessionMarker;
    const repeated = repush(browserState);
    assert.equal(f.roots[0]!.querySelector("webview"), browser);
    assert.equal(browser.sessionMarker, session);
    browser.remove();
    repush(repeated);
    const restored = f.roots[0]!.querySelector("webview") as HTMLElement & { src?: string };
    assert.ok(restored); assert.ok(restored !== browser);
    assert.equal(restored.src, browser.src);
    assert.equal(f.roots[1]!.querySelector("webview"), f.guests[1]);
  });
  await test("late readiness from retired guest does not mark reconstructed document ready", async () => {
    const f = duplicateFixture();
    const old = f.guests[0]! as HTMLElement & { executeJavaScript?: (script: string) => Promise<unknown> };
    const pendingReady: { resolve?: (value: string) => void } = {};
    old.executeJavaScript = script => script === "document.readyState"
      ? new Promise(resolve => { pendingReady.resolve = resolve; })
      : Promise.resolve(null);
    old.dispatchEvent(new window.Event("did-stop-loading"));
    assert.ok(pendingReady.resolve);
    old.remove();
    repush(f.next);
    const current = f.roots[0]!.querySelector("webview") as HTMLElement;
    assert.ok(current); assert.ok(current !== old);
    pendingReady.resolve!("complete");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.notEqual(old.dataset.guestReady, "true");
    assert.notEqual(current.dataset.guestReady, "true");
    assert.equal(f.roots[1]!.querySelector("webview"), f.guests[1]);
  });

});
