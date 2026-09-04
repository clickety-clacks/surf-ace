import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AllocatorError,
  canonicalJson,
  journalHeadHash,
  ordinalToWindowLabel,
  parseAllocatorRequest,
  windowLabelToOrdinal,
} from "./index.js";

test("base-26 labels match the fleet sequence and round-trip", () => {
  const cases = new Map<number, string>([
    [0, "a"],
    [1, "b"],
    [25, "z"],
    [26, "aa"],
    [27, "ab"],
    [51, "az"],
    [52, "ba"],
    [701, "zz"],
    [702, "aaa"],
  ]);
  for (const [ordinal, label] of cases) {
    assert.equal(ordinalToWindowLabel(ordinal), label);
    assert.equal(windowLabelToOrdinal(label), ordinal);
  }
});

test("RFC 8785 event bytes sort object properties by UTF-16 code units", () => {
  const event = {
    z: 3,
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "😀": "Emoji: Grinning Face",
    "\u0080": "Control",
    ö: "Latin Small Letter O With Diaeresis",
  };
  assert.equal(
    canonicalJson(event),
    '{"\\r":"Carriage Return","1":"One","z":3,"":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
});

test("journal head is SHA-256 of previous hash followed by canonical bytes", () => {
  const previous = Buffer.alloc(32, 0x5a);
  const result = journalHeadHash(previous, { ordinal: 26, type: "reserved" });
  assert.equal(result.eventBytes.toString(), '{"ordinal":26,"type":"reserved"}');
  assert.deepEqual(
    result.headHash,
    createHash("sha256").update(previous).update(result.eventBytes).digest(),
  );
});

test("closed claim envelope accepts only the specified fields", () => {
  const request = {
    id: "rq_1",
    op: "label.claim",
    payload: {
      authorityId: `auth_${"a".repeat(22)}`,
      fleetId: "fleet-1",
      ownerAnchorId: `owner_${"b".repeat(22)}`,
      protocolVersion: 1,
      surfaceId: "sf_001",
    },
    sentAt: 1,
    type: "request",
    v: 1,
  };
  assert.deepEqual(parseAllocatorRequest(request), request);
  assert.throws(
    () => parseAllocatorRequest({ ...request, payload: { ...request.payload, extra: true } }),
    (error) => error instanceof AllocatorError && error.code === "invalid_payload",
  );
});

test("reconfirm rejects an assignment whose label does not encode its ordinal", () => {
  assert.throws(
    () => parseAllocatorRequest({
      id: "rq_2",
      op: "label.reconfirm",
      payload: {
        authorityId: `auth_${"a".repeat(22)}`,
        expectedAllocatorId: "alloc_one",
        expectedAssignment: { committed: true, ordinal: 1, windowLabel: "c" },
        fleetId: "fleet-1",
        ownerAnchorId: `owner_${"b".repeat(22)}`,
        protocolVersion: 1,
        surfaceId: "sf_001",
      },
      sentAt: 1,
      type: "request",
      v: 1,
    }),
    (error) => error instanceof AllocatorError && error.code === "invalid_payload",
  );
});
