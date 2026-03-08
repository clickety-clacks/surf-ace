import { strict as assert } from "node:assert";
import { validateEnvelopeType } from "./validate";

const ok = validateEnvelopeType("pair.request", {
  type: "pair.request",
  payload: { providerId: "p", connectionId: "c", surfaceId: "s", protocolVersion: 1 },
});
assert.equal(ok.ok, true);

const bad = validateEnvelopeType("pair.request", {
  type: "content.set",
  payload: {},
});
assert.equal(bad.ok, false);
