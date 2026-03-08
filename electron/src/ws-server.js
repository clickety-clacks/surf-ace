/**
 * Fresh WS-era surface server scaffold.
 * Contract source: ../DESIGN.md + packages/protocol.
 */

export function buildPairResponse({ sessionId, surfaceId, name, width, height }) {
  return {
    type: "pair.response",
    payload: {
      sessionId,
      resumed: false,
      surface: {
        id: surfaceId,
        name,
        viewport: { width, height },
      },
      currentContentId: null,
      currentRevision: 0,
      contentType: null,
    },
  };
}
