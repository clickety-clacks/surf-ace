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
  indicator.textContent = contentScalePercentage(scale);
}
