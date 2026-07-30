import { createHash } from "node:crypto";
import path from "node:path";

import {
  BoundedControllerProjection,
  ControllerIdentity,
  FileControllerStateStore,
  MultiSurfaceController,
  PublicControllerWireClient,
} from "@surf-ace/controller";

import { TightBeamSurfAceAdapter } from "./adapter.js";

export type TightBeamAdapterOptions = {
  projectionCapacityBytes: number;
  stateDir: string;
  url: string;
};

export function createTightBeamSurfAceAdapter(
  options: TightBeamAdapterOptions,
): TightBeamSurfAceAdapter {
  const identity = new ControllerIdentity(
    new FileControllerStateStore(
      path.join(options.stateDir, "controller-identity.json"),
    ),
  );
  return new TightBeamSurfAceAdapter(new MultiSurfaceController({
    controllerProductName: "Tight Beam",
    createProjection: (scopeKey) => {
      const stateKey = createHash("sha256").update(scopeKey).digest("hex")
        .slice(0, 16);
      return new BoundedControllerProjection(
        new FileControllerStateStore(
          path.join(options.stateDir, "projections", stateKey, "state.json"),
        ),
        options.projectionCapacityBytes,
      );
    },
    createWire: () => new PublicControllerWireClient(options.url),
    identity,
  }));
}
