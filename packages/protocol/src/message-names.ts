/**
 * Surf Ace protocol message names extracted from DESIGN.md.
 *
 * This is intentionally names-only for now so provider + clients can
 * share canonical operation/event ids while payload schemas are filled in.
 */

export const REQUEST_MESSAGES = [
  "surfaces.list",
  "pair.request",
  "pane.list",
  "pane.create",
  "pane.remove",
  "pane.focus",
  "pane.rename",
  "tab.list",
  "tab.close",
  "content.set",
  "content.append",
  "content.patch",
  "content.clear",
  "snapshot.get",
  "heartbeat",
] as const;

export const RESPONSE_MESSAGES = [
  "surfaces.list.response",
  "pair.response",
  "pane.list.response",
  "pane.create.response",
  "pane.remove.response",
  "pane.focus.response",
  "pane.rename.response",
  "tab.list.response",
  "tab.close.response",
  "content.set.response",
  "content.append.response",
  "content.patch.response",
  "content.clear.response",
  "snapshot.get.response",
  "error",
] as const;

export const EVENT_MESSAGES = [
  "event.surface_appeared",
  "event.surface_removed",
  "event.pane_created",
  "event.pane_removed",
  "event.pane_focused",
  "event.pane_renamed",
  "event.tab_created",
  "event.tab_removed",
  "event.tab_focused",
  "event.drawing_flush",
  "event.tap",
  "event.selection",
  "event.page_turn",
  "event.navigation",
  "event.scroll",
  "event.snapshot_hint",
] as const;

export type RequestMessageName = (typeof REQUEST_MESSAGES)[number];
export type ResponseMessageName = (typeof RESPONSE_MESSAGES)[number];
export type EventMessageName = (typeof EVENT_MESSAGES)[number];
export type SurfAceMessageName =
  | RequestMessageName
  | ResponseMessageName
  | EventMessageName;
