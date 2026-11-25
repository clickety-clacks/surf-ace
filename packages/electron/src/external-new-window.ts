export const EXTERNAL_NEW_WINDOW_EVENT = "surf-ace-external-new-window";

export function externalNewWindowFrameScript(): string {
  return `(() => {
  const eventName = ${JSON.stringify(EXTERNAL_NEW_WINDOW_EVENT)};
  const dispatchEvent = window.dispatchEvent;
  const CustomEventConstructor = CustomEvent;
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
    Reflect.apply(dispatchEvent, window, [new CustomEventConstructor(eventName, { detail: { url } })]);
    return true;
  };
  const installAnchorHandler = () => {
    window.addEventListener("click", (event) => {
      if (!event.isTrusted || !navigator.userActivation?.isActive || !(event.target instanceof Element)) return;
      if (event.defaultPrevented) return;
      const link = event.target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target.trim().toLowerCase() !== "_blank") return;
      const url = resolveHttpUrl(link.href);
      if (!url) return;
      event.preventDefault();
      requestExternalOpen(url);
    });
  };
  if (document.readyState === "complete") {
    installAnchorHandler();
  } else {
    const installAfterLoad = (event) => {
      if (!event.isTrusted) return;
      window.removeEventListener("load", installAfterLoad);
      queueMicrotask(installAnchorHandler);
    };
    window.addEventListener("load", installAfterLoad);
  }
  const originalOpen = window.open;
  window.open = function(url, target, features) {
    const targetName = arguments.length > 1 && target !== undefined ? String(target).trim().toLowerCase() : "_blank";
    const rawUrl = arguments.length > 0 ? url : undefined;
    const resolvedUrl = rawUrl == null || !String(rawUrl).trim() ? null : resolveHttpUrl(String(rawUrl));
    if (targetName === "_blank" && resolvedUrl && navigator.userActivation?.isActive) {
      if (requestExternalOpen(resolvedUrl)) return null;
    }
    return Reflect.apply(originalOpen, this, arguments);
  };
})();`;
}

export function externalNewWindowRequestUrl(detail: unknown, userActivationIsActive: boolean): string | null {
  if (!userActivationIsActive || !detail || typeof detail !== "object") {
    return null;
  }
  const rawUrl = (detail as { url?: unknown }).url;
  return typeof rawUrl === "string" ? resolveExternalHttpUrl(rawUrl) : null;
}

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
