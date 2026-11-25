export const EXTERNAL_NEW_WINDOW_EVENT = "surf-ace-external-new-window";
export const EXTERNAL_NEW_WINDOW_FEATURE = "surf-ace-external-new-window";

export function externalNewWindowFrameScript(): string {
  return `(() => {
  const eventName = ${JSON.stringify(EXTERNAL_NEW_WINDOW_EVENT)};
  const externalNewWindowFeature = ${JSON.stringify(EXTERNAL_NEW_WINDOW_FEATURE)};
  const dispatchEvent = window.dispatchEvent;
  const CustomEventConstructor = CustomEvent;
  let nextRequestId = 0;
  const resolveHttpUrl = (rawUrl) => {
    try {
      const url = new URL(String(rawUrl), document.baseURI);
      return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.href : null;
    } catch {
      return null;
    }
  };
  const dispatchRequestPhase = (phase, requestId, url) => {
    Reflect.apply(dispatchEvent, window, [new CustomEventConstructor(eventName, {
      detail: { phase, requestId, ...(url ? { url } : {}) },
    })]);
  };
  const prepareExternalOpen = (rawUrl) => {
    if (!navigator.userActivation?.isActive) return false;
    const url = resolveHttpUrl(rawUrl);
    if (!url) return false;
    const requestId = ++nextRequestId;
    dispatchRequestPhase("prepare", requestId, url);
    return requestId;
  };
  const finishExternalOpen = (requestId, phase) => {
    dispatchRequestPhase(phase, requestId);
  };
  const requestExternalOpen = (rawUrl) => {
    const requestId = prepareExternalOpen(rawUrl);
    if (!requestId) return false;
    finishExternalOpen(requestId, "complete");
    return true;
  };
  const appendExternalNewWindowFeature = (features) => {
    const original = features == null ? "" : String(features).trim();
    return original ? original + "," + externalNewWindowFeature + "=1" : externalNewWindowFeature + "=1";
  };
  window.addEventListener("click", (event) => {
    if (!event.isTrusted || !navigator.userActivation?.isActive || !(event.target instanceof Element)) return;
    if (event.defaultPrevented) return;
    const link = event.target.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement) || link.target.trim().toLowerCase() !== "_blank") return;
    const url = resolveHttpUrl(link.href);
    if (!url) return;

    const requestId = prepareExternalOpen(url);
    if (!requestId) return;
    let canceledByPage = false;
    const preventDefault = event.preventDefault.bind(event);
    event.preventDefault = function(...args) {
      canceledByPage = true;
      return Reflect.apply(preventDefault, event, args);
    };
    preventDefault();
    setTimeout(() => {
      finishExternalOpen(requestId, canceledByPage ? "cancel" : "complete");
    });
  }, true);

  const originalOpen = window.open;
  window.open = function(url, target, features) {
    const targetName = arguments.length > 1 && target !== undefined ? String(target).trim().toLowerCase() : "_blank";
    const rawUrl = arguments.length > 0 ? url : undefined;
    const resolvedUrl = rawUrl == null || !String(rawUrl).trim() ? null : resolveHttpUrl(String(rawUrl));
    const specialTarget = ["_self", "_parent", "_top", "_unfencedtop"].includes(targetName);
    if (resolvedUrl && navigator.userActivation?.isActive && !specialTarget) {
      if (targetName === "_blank" || targetName === "") {
        if (requestExternalOpen(resolvedUrl)) return null;
      } else {
        const requestId = prepareExternalOpen(resolvedUrl);
        if (!requestId) return Reflect.apply(originalOpen, this, arguments);
        const args = Array.from(arguments);
        args[2] = appendExternalNewWindowFeature(features);
        const opened = Reflect.apply(originalOpen, this, args);
        finishExternalOpen(requestId, opened === null ? "complete" : "cancel");
        return opened;
      }
    }
    return Reflect.apply(originalOpen, this, arguments);
  };
})();`;
}

export function appendExternalNewWindowFeature(features: unknown): string {
  const original = features == null ? "" : String(features).trim();
  return original ? `${original},${EXTERNAL_NEW_WINDOW_FEATURE}=1` : `${EXTERNAL_NEW_WINDOW_FEATURE}=1`;
}

export function hasExternalNewWindowFeature(features: string): boolean {
  return features.split(",").some((feature) => {
    const separator = feature.indexOf("=");
    const name = (separator < 0 ? feature : feature.slice(0, separator)).trim().toLowerCase();
    const value = separator < 0 ? "" : feature.slice(separator + 1).trim().toLowerCase();
    return name === EXTERNAL_NEW_WINDOW_FEATURE && value === "1";
  });
}

export function externalNewWindowRequestUrl(detail: unknown, userActivationIsActive: boolean): string | null {
  if (!userActivationIsActive || !detail || typeof detail !== "object") {
    return null;
  }
  const rawUrl = (detail as { url?: unknown }).url;
  return typeof rawUrl === "string" ? resolveExternalHttpUrl(rawUrl) : null;
}

export function createExternalNewWindowRequestBridge(
  openExternal: (url: string) => void,
): (detail: unknown, userActivationIsActive: boolean) => void {
  const pending = new Map<number, string>();
  return (detail, userActivationIsActive) => {
    if (!detail || typeof detail !== "object") return;
    const request = detail as { phase?: unknown; requestId?: unknown; url?: unknown };
    if (!Number.isSafeInteger(request.requestId) || (request.requestId as number) < 1) return;
    const requestId = request.requestId as number;
    if (request.phase === "prepare") {
      const url = externalNewWindowRequestUrl(request, userActivationIsActive);
      if (url) pending.set(requestId, url);
      return;
    }
    if (request.phase === "cancel") {
      pending.delete(requestId);
      return;
    }
    if (request.phase === "complete") {
      const url = pending.get(requestId);
      pending.delete(requestId);
      if (url) openExternal(url);
    }
  };
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
