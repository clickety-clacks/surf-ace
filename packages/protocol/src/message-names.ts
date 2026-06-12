export const REQUEST_MESSAGES = [
  "surfaces.list",
  "pair.request",
  "ownership.relinquish",
  "surface.window.open",
  "target.apply",
  "target.register",
  "content.set",
  "content.append",
  "content.patch",
  "content.clear",
  "annotations.remove",
  "snapshot.get",
  "authority.state",
  "heartbeat.ping",
  "panes.list",
  "pane.split",
  "pane.rename",
  "pane.close",
] as const;

export const RESPONSE_MESSAGES = [
  "surfaces.list",
  "pair.request",
  "ownership.relinquish",
  "surface.window.open",
  "target.apply.result",
  "target.registered",
  "target.register.rejected",
  "content.set",
  "content.append",
  "content.patch",
  "content.clear",
  "annotations.remove",
  "snapshot.get",
  "authority.state",
  "heartbeat.ping",
  "panes.list",
  "pane.split",
  "pane.rename",
  "pane.close",
] as const;

export const EVENT_MESSAGES = [
  "event.drawing_flush",
  "event.annotation_committed",
  "event.tap",
  "event.scroll",
  "event.selection",
  "event.page",
  "event.navigation",
  "event.surface_appeared",
  "event.surface_removed",
  "event.surface_resumed",
  "event.topology_changed",
  "event.snapshot_hint",
  "event.pane_created",
  "event.pane_removed",
  "event.pane_renamed",
] as const;

export type RequestMessageName = (typeof REQUEST_MESSAGES)[number];
export type ResponseMessageName = (typeof RESPONSE_MESSAGES)[number];
export type EventMessageName = (typeof EVENT_MESSAGES)[number];
export type SurfAceMessageName =
  | RequestMessageName
  | ResponseMessageName
  | EventMessageName;
