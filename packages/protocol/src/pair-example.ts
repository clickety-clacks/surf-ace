import type { PairRequest, PairResponse } from "./messages";

export function buildExamplePairRequest(): PairRequest {
  return {
    type: "pair.request",
    payload: {
      providerId: "provider_main",
      connectionId: "conn_001",
      surfaceId: "surface_A",
      protocolVersion: 1,
      eventProfile: "minimum_deep",
      drawingFlushConfig: {
        idleWindowMs: 8000,
        maxIntervalMs: 30000,
      },
    },
  };
}

export function buildExamplePairResponse(): PairResponse {
  return {
    type: "pair.response",
    payload: {
      sessionId: "sess_001",
      resumed: false,
      surface: {
        id: "surface_A",
        name: "Surf Ace A",
        viewport: { width: 1366, height: 1024 },
      },
      currentContentId: null,
      currentRevision: 0,
      contentType: null,
    },
  };
}
