import type { PairRequest, PairResponse } from "./index";

export function buildExamplePairRequest(): PairRequest {
  return {
    id: "rq_example_pair_request" as PairRequest["id"],
    op: "pair.request",
    payload: {
      connectionId: "cn_example_pair" as PairRequest["payload"]["connectionId"],
      drawingFlushConfig: {
        idleWindowMs: 8000,
        maxIntervalMs: 30000,
      },
      eventProfile: "minimum_deep",
      initialPaneId: 1 as PairRequest["payload"]["initialPaneId"],
      protocolVersion: 1,
      providerId: "pv_example_provider" as PairRequest["payload"]["providerId"],
      surfaceId: "sf_surface_a" as PairRequest["payload"]["surfaceId"],
      windowLabel: "a",
    },
    sentAt: 0 as PairRequest["sentAt"],
    type: "request",
    v: 1,
  };
}

export function buildExamplePairResponse(): PairResponse {
  return {
    id: "rq_example_pair_request" as PairResponse["id"],
    ok: true,
    op: "pair.request",
    payload: {
      capabilities: {
        contentTypes: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"],
        eventTypes: ["event.drawing_flush", "event.tap", "event.selection"],
      },
      eventConfig: {
        activeEvents: ["event.drawing_flush", "event.tap", "event.selection"],
        drawingFlushConfig: {
          idleWindowMs: 8000,
          maxIntervalMs: 30000,
        },
        profile: "minimum_deep",
      },
      limits: {
        maxDrawingFlushBytes: 1024,
        maxFrameBytes: 1024,
        maxMessageBytes: 1024,
        maxStrokePointsPerFlush: 1024,
        maxVisibleTextBytes: 1024,
        resumeGraceMs: 20_000,
      },
      resumed: false,
      sessionId: "sa_example_session" as PairResponse["payload"]["sessionId"],
      state: {
        panes: [
          {
            contentType: null,
            currentContentId: null,
            currentRevision: 0 as PairResponse["payload"]["state"]["panes"][number]["currentRevision"],
            paneId: 1 as PairResponse["payload"]["state"]["panes"][number]["paneId"],
          },
        ],
      },
      surfaceId: "sf_surface_a" as PairResponse["payload"]["surfaceId"],
      surfaceName: "Surf Ace A",
      viewport: {
        height: 1024,
        scale: 2,
        width: 1366,
      },
    },
    sentAt: 0 as PairResponse["sentAt"],
    type: "response",
    v: 1,
  };
}
