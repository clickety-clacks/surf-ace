import assert from "node:assert/strict";
import test from "node:test";
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
    displayId: String(paneId),
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
    visibleAddress: String(paneId),
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
  let provenanceWidth = 200;
  let textMetricScale = 1;
  const commands: unknown[] = [];
  const resizeCallbacks: Array<() => void> = [];
  const mutationCallbacks: Array<() => void> = [];
  const fontCallbacks: Array<() => void> = [];
  const surfAce = {
    clearToast() {},
    command(command: unknown) { commands.push(command); },
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
  assert.equal(chrome().glyph.hasAttribute("hidden"), false);
  assert.equal(chrome().pane.hasAttribute("hidden"), true);

  stateListener!(state("connecting"));
  assert.equal(chrome().glyph.classList.contains("is-connecting"), true);
  assert.equal(chrome().pane.hasAttribute("hidden"), true);
  stateListener!(state("connected"));
  assert.equal(chrome().glyph.hasAttribute("hidden"), true);
  assert.equal(chrome().pane.hasAttribute("hidden"), false);
  assert.equal(chrome().window.hasAttribute("hidden"), false);
  stateListener!(state("disconnected"));
  assert.equal(chrome().glyph.hasAttribute("hidden"), false);
  assert.equal(chrome().pane.hasAttribute("hidden"), true);

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
});
