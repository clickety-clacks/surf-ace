import assert from "node:assert/strict";
import test from "node:test";

import { validateEnvelopeType } from "./validate.js";

test("validateEnvelopeType accepts current request envelopes", () => {
  const result = validateEnvelopeType("pair.request", {
    id: "req_1",
    op: "pair.request",
    payload: {
      connectionId: "cn_1",
      protocolVersion: 1,
      providerId: "prov_1",
      surfaceId: "sf_1",
    },
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });

  assert.deepEqual(result, { ok: true });
});

test("validateEnvelopeType rejects op/type drift", () => {
  const opMismatch = validateEnvelopeType("pair.request", {
    id: "req_1",
    op: "content.set",
    payload: {},
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  assert.deepEqual(opMismatch, { ok: false, reason: "op_mismatch:content.set" });

  const typeMismatch = validateEnvelopeType("pair.request", {
    id: "req_1",
    op: "pair.request",
    payload: {},
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(typeMismatch, { ok: false, reason: "type_mismatch:response" });
});

test("validateEnvelopeType requires event ids on current event envelopes", () => {
  const missingEventId = validateEnvelopeType("event.drawing_flush", {
    op: "event.drawing_flush",
    payload: {},
    sentAt: Date.now(),
    type: "event",
    v: 1,
  });
  assert.deepEqual(missingEventId, { ok: false, reason: "event_id_missing" });
});
