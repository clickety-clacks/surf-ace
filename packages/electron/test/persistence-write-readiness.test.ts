import assert from "node:assert/strict";
import test from "node:test";

import { PersistenceWriteReadiness } from "../src/persistence-write-readiness.js";

test("readiness remains closed until every queued durable write settles", async () => {
  const readiness = new PersistenceWriteReadiness();
  let resolveFirst!: () => void;
  let rejectSecond!: (error: Error) => void;
  const firstWrite = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const secondWrite = new Promise<void>((_resolve, reject) => { rejectSecond = reject; });

  const first = readiness.track(() => firstWrite);
  const second = readiness.track(() => secondWrite);
  assert.equal(readiness.isReady, false);
  resolveFirst();
  await first;
  assert.equal(readiness.isReady, false);
  rejectSecond(new Error("write failed"));
  await assert.rejects(second, /write failed/);
  assert.equal(readiness.isReady, true);
});
