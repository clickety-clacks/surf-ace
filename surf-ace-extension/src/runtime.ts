import type { PairRequest } from "../../packages/protocol/src/messages";

/**
 * Placeholder runtime shell for the new WS provider model.
 */
export class SurfAceWsRuntime {
  buildPairRequest(input: {
    providerId: string;
    connectionId: string;
    surfaceId: string;
  }): PairRequest {
    return {
      type: "pair.request",
      payload: {
        providerId: input.providerId,
        connectionId: input.connectionId,
        surfaceId: input.surfaceId,
        protocolVersion: 1,
      },
    };
  }
}
