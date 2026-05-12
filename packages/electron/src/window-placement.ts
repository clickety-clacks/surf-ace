import type { Rectangle } from "electron";

export type WindowPlacement = {
  bounds: Rectangle;
  displayId?: number;
  fullscreen: boolean;
};

export type DisplayLike = {
  id: number;
  workArea: Rectangle;
};

const MIN_WINDOW_SIZE = 200;

export function sanitizeWindowPlacement(input: unknown): WindowPlacement | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as {
    bounds?: Partial<Rectangle>;
    displayId?: unknown;
    fullscreen?: unknown;
  };
  const bounds = record.bounds;
  if (!bounds || typeof bounds !== "object") {
    return null;
  }
  const x = finiteNumber(bounds.x);
  const y = finiteNumber(bounds.y);
  const width = finiteNumber(bounds.width);
  const height = finiteNumber(bounds.height);
  if (x === null || y === null || width === null || height === null || width < MIN_WINDOW_SIZE || height < MIN_WINDOW_SIZE) {
    return null;
  }
  const displayId = typeof record.displayId === "number" && Number.isFinite(record.displayId)
    ? Math.trunc(record.displayId)
    : undefined;
  return {
    bounds: {
      height: Math.floor(height),
      width: Math.floor(width),
      x: Math.floor(x),
      y: Math.floor(y),
    },
    ...(displayId === undefined ? {} : { displayId }),
    fullscreen: record.fullscreen === true,
  };
}

export function restoreWindowPlacement(
  placement: WindowPlacement | null | undefined,
  displays: DisplayLike[],
  primaryDisplay: DisplayLike,
): WindowPlacement | null {
  const sanitized = sanitizeWindowPlacement(placement);
  if (!sanitized) {
    return null;
  }
  const targetDisplay = displays.find((display) => display.id === sanitized.displayId)
    ?? displays.find((display) => intersects(sanitized.bounds, display.workArea))
    ?? primaryDisplay;
  return {
    ...sanitized,
    bounds: clampToWorkArea(sanitized.bounds, targetDisplay.workArea),
    displayId: targetDisplay.id,
  };
}

export function cloneWindowPlacement(placement: WindowPlacement | null | undefined): WindowPlacement | null {
  const sanitized = sanitizeWindowPlacement(placement);
  return sanitized ? { ...sanitized, bounds: { ...sanitized.bounds } } : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function intersects(rect: Rectangle, area: Rectangle): boolean {
  return rect.x < area.x + area.width &&
    rect.x + rect.width > area.x &&
    rect.y < area.y + area.height &&
    rect.y + rect.height > area.y;
}

function clampToWorkArea(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    height,
    width,
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
  };
}
