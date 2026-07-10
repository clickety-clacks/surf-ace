export type ConnectionBarState = "connected" | "connecting" | "disconnected";

export type ConnectionChromeElements = {
  disconnectedGlyph: Element;
  paneLabel: Element;
  windowLabel: Element;
};

export function projectConnectionChrome(
  elements: ConnectionChromeElements,
  connectionBar: ConnectionBarState,
  hasPaneLabel: boolean,
  hasWindowLabel: boolean,
): void {
  const showsIdentity = connectionBar === "connected";
  elements.windowLabel.toggleAttribute("hidden", !showsIdentity || !hasWindowLabel);
  elements.paneLabel.toggleAttribute("hidden", !showsIdentity);
  elements.disconnectedGlyph.toggleAttribute("hidden", showsIdentity);
  elements.disconnectedGlyph.classList.toggle("is-connecting", connectionBar === "connecting");
  elements.disconnectedGlyph.classList.toggle("is-disconnected", connectionBar === "disconnected");
  elements.paneLabel.parentElement?.toggleAttribute("hidden", showsIdentity && !hasPaneLabel);
}

export function contentScalePercentage(scale: number): string {
  return String(Math.round(scale * 100));
}

export function projectContentScaleIndicator(indicator: Element, scale: number): void {
  const label = indicator.querySelector(".control-button__label") ?? indicator;
  label.textContent = contentScalePercentage(scale);
}

export type ContentScaleAction = "decrease" | "increase" | "reset";

export function toggleContentScalePopup(
  openPaneId: number | null,
  paneId: number,
): { openPaneId: number | null; rebuildPaneIds: number[] } {
  const nextOpenPaneId = openPaneId === paneId ? null : paneId;
  return {
    openPaneId: nextOpenPaneId,
    rebuildPaneIds: openPaneId === null || openPaneId === paneId ? [paneId] : [openPaneId, paneId],
  };
}

export function bindContentScaleControls(options: {
  annotationPill: Element;
  decrease: HTMLButtonElement | null;
  fontSizePopover: HTMLElement | null;
  fontSizeToggle: HTMLButtonElement;
  increase: HTMLButtonElement | null;
  onScale: (action: ContentScaleAction) => void;
  onToggle: () => void;
  reset: HTMLButtonElement | null;
  scale: number;
}): void {
  options.fontSizeToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onToggle();
  });
  options.annotationPill.appendChild(options.fontSizeToggle);

  if (!options.fontSizePopover || !options.decrease || !options.reset || !options.increase) {
    return;
  }
  options.fontSizePopover.addEventListener("click", (event) => event.stopPropagation());
  options.decrease.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onScale("decrease");
  });
  projectContentScaleIndicator(options.reset, options.scale);
  options.reset.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onScale("reset");
  });
  options.increase.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onScale("increase");
  });
  options.fontSizePopover.append(options.decrease, options.reset, options.increase);
  options.annotationPill.appendChild(options.fontSizePopover);
}
