export const externalNewWindowFrameScript = `(() => {
  const resolveHttpUrl = (rawUrl) => {
    try {
      const url = new URL(String(rawUrl), document.baseURI);
      return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.href : null;
    } catch {
      return null;
    }
  };
  const requestExternalOpen = (rawUrl) => {
    if (!navigator.userActivation?.isActive) return false;
    const url = resolveHttpUrl(rawUrl);
    if (!url) return false;
    window.top.postMessage({ type: "surf-ace-external-new-window", url }, "*");
    return true;
  };
  let anchorOpenUrl = null;
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || !navigator.userActivation?.isActive || !(event.target instanceof Element)) return;
    const link = event.target.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement) || link.target.toLowerCase() !== "_blank") return;
    const url = resolveHttpUrl(link.href);
    if (!url) return;
    event.preventDefault();
    anchorOpenUrl = url;
    queueMicrotask(() => {
      if (anchorOpenUrl === url) anchorOpenUrl = null;
    });
    requestExternalOpen(url);
  }, true);
  const originalOpen = window.open;
  window.open = function(url, target, features) {
    const targetName = arguments.length > 1 ? String(target).trim().toLowerCase() : "_blank";
    const opensNewContext = targetName !== "_self" && targetName !== "_parent" && targetName !== "_top";
    const resolvedUrl = arguments.length > 0 ? resolveHttpUrl(url) : null;
    if (opensNewContext && resolvedUrl && navigator.userActivation?.isActive) {
      if (anchorOpenUrl === resolvedUrl) return null;
      if (requestExternalOpen(resolvedUrl)) return null;
    }
    return Reflect.apply(originalOpen, this, arguments);
  };
})();`;

export function resolveExternalHttpUrl(rawUrl: string, baseUrl?: string): string | null {
  try {
    const resolved = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    if ((resolved.protocol !== "http:" && resolved.protocol !== "https:") || !resolved.hostname) {
      return null;
    }
    return resolved.href;
  } catch {
    return null;
  }
}

export function isExternalNewWindowLink(target: string, rawUrl: string, baseUrl?: string): boolean {
  return target.toLowerCase() === "_blank" && resolveExternalHttpUrl(rawUrl, baseUrl) !== null;
}

export function embeddedNewWindowAction(isStaticHtml: boolean): "allow" | "deny" {
  return isStaticHtml ? "deny" : "allow";
}
