import assert from "node:assert/strict";
import test from "node:test";

import { AllocatorError } from "./domain.js";
import { verifyReleaseWitnessWithRetry } from "./custody.js";

test("committed lease release rechecks a transient witness fence without replaying the mutation", async () => {
  let reads = 0;
  const delays: number[] = [];
  const result = await verifyReleaseWitnessWithRetry(async () => {
    reads += 1;
    if (reads === 1) throw new AllocatorError("writer_fence_unavailable", "transient witness sender state");
    return "verified-witness-head";
  }, async (ms) => { delays.push(ms); });
  assert.equal(result, "verified-witness-head");
  assert.equal(reads, 2);
  assert.deepEqual(delays, [100]);
});

test("committed lease release stays fail-closed if the witness never validates", async () => {
  let reads = 0;
  const delays: number[] = [];
  await assert.rejects(
    verifyReleaseWitnessWithRetry(async () => {
      reads += 1;
      throw new AllocatorError("writer_fence_unavailable", "persistent witness mismatch");
    }, async (ms) => { delays.push(ms); }),
    (error) => error instanceof AllocatorError && error.code === "writer_fence_unavailable",
  );
  assert.equal(reads, 6);
  assert.deepEqual(delays, [100, 250, 500, 1_000, 2_000]);
});

test("committed lease release does not wait through witness corruption", async () => {
  let reads = 0;
  await assert.rejects(
    verifyReleaseWitnessWithRetry(async () => {
      reads += 1;
      throw new AllocatorError("allocator_state_corrupt", "witness head mismatch");
    }, async () => { throw new Error("unexpected wait"); }),
    (error) => error instanceof AllocatorError && error.code === "allocator_state_corrupt",
  );
  assert.equal(reads, 1);
});
