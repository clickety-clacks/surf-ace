import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_MESSAGES,
  REQUEST_MESSAGES,
} from "./message-names.js";
import { SURF_ACE_PROTOCOL_SCHEMAS } from "./schemas-manifest.js";
import { drawingFlushEventSchema } from "./schemas.js";
import { validateEnvelopeType } from "./validate.js";

test("validateEnvelopeType accepts current request envelopes", () => {
  const result = validateEnvelopeType("pair.request", {
    id: "req_1",
    op: "pair.request",
    payload: {
      connectionId: "cn_1",
      initialPaneId: 1,
      protocolVersion: 1,
      providerId: "prov_1",
      providerName: "test-harness",
      surfaceId: "sf_1",
      windowLabel: "a",
    },
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });

  assert.deepEqual(result, { ok: true });
});

test("validateEnvelopeType rejects pair requests without providerName", () => {
  const result = validateEnvelopeType("pair.request", {
    id: "req_missing_provider_name",
    op: "pair.request",
    payload: {
      connectionId: "cn_1",
      initialPaneId: 1,
      protocolVersion: 1,
      providerId: "prov_1",
      surfaceId: "sf_1",
      windowLabel: "a",
    },
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });

  assert.equal(result.ok, false);
});

test("manifest covers every spec-defined request, response, and event op", () => {
  const schemaNames = Object.keys(SURF_ACE_PROTOCOL_SCHEMAS).sort();
  const expectedNames = [...new Set([...REQUEST_MESSAGES, ...EVENT_MESSAGES])].sort();

  assert.deepEqual(schemaNames, expectedNames);

  for (const op of REQUEST_MESSAGES) {
    const entry = SURF_ACE_PROTOCOL_SCHEMAS[op];
    assert.ok(entry.request, `${op} request schema missing`);
    assert.ok(entry.response, `${op} response schema missing`);
    assert.ok(entry.errorResponse, `${op} error response schema missing`);
  }

  for (const op of EVENT_MESSAGES) {
    const entry = SURF_ACE_PROTOCOL_SCHEMAS[op];
    assert.ok(entry.event, `${op} event schema missing`);
  }
});

test("validateEnvelopeType accepts payloadless list requests and responses", () => {
  const surfacesListRequest = validateEnvelopeType("surfaces.list", {
    id: "req_1",
    op: "surfaces.list",
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  assert.deepEqual(surfacesListRequest, { ok: true });

  const panesListRequest = validateEnvelopeType("panes.list", {
    id: "req_2",
    op: "panes.list",
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  assert.deepEqual(panesListRequest, { ok: true });

  const relinquishRequest = validateEnvelopeType("ownership.relinquish", {
    id: "req_3",
    op: "ownership.relinquish",
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  assert.deepEqual(relinquishRequest, { ok: true });

  const pairResponse = validateEnvelopeType("pair.request", {
    id: "req_4",
    ok: true,
    op: "pair.request",
    payload: {},
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(pairResponse, { ok: true });

  const relinquishResponse = validateEnvelopeType("ownership.relinquish", {
    id: "req_5",
    ok: true,
    op: "ownership.relinquish",
    payload: {
      relinquished: true,
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(relinquishResponse, { ok: true });

  const errorResponse = validateEnvelopeType("pair.request", {
    error: {
      code: "internal_error",
      message: "boom",
    },
    id: "req_6",
    ok: false,
    op: "pair.request",
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(errorResponse, { ok: true });
});

test("validateEnvelopeType rejects op drift", () => {
  const opMismatch = validateEnvelopeType("pair.request", {
    id: "req_1",
    op: "content.set",
    payload: {},
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  assert.deepEqual(opMismatch, { ok: false, reason: "op_mismatch:content.set" });
});

test("validateEnvelopeType rejects unsupported envelope kinds", () => {
  const typeMismatch = validateEnvelopeType("event.drawing_flush", {
    id: "req_1",
    op: "event.drawing_flush",
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

test("drawingFlushEventSchema matches the canonical schema bounds", () => {
  const payload = (
    drawingFlushEventSchema as {
      properties: {
        payload: {
          properties: {
            flushReason: { enum: string[] };
            idleWindowMs: { minimum: number };
            maxIntervalMs: { minimum: number };
            strokeCount: { minimum: number };
            pointsCount: { minimum: number };
            strokes: { minItems: number };
          };
        };
      };
    }
  ).properties.payload.properties;

  assert.deepEqual(payload.flushReason.enum, ["idle_window", "max_interval"]);
  assert.equal(payload.idleWindowMs.minimum, 5000);
  assert.equal(payload.maxIntervalMs.minimum, 10000);
  assert.equal(payload.strokeCount.minimum, 1);
  assert.equal(payload.pointsCount.minimum, 1);
  assert.equal(payload.strokes.minItems, 1);
});
