import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationFlushGate, type AnnotationFlushScheduler } from "../src/annotation-flush-gate.js";

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const scheduler: AnnotationFlushScheduler = {
    schedule: (callback, delayMs) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (timer) => { timers.delete(Number(timer)); },
  };
  return {
    now: () => now,
    scheduler,
    advance: async (duration: number) => {
      now += duration;
      while (true) {
        const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)
          .find(([, item]) => item.at <= now);
        if (!due) break;
        timers.delete(due[0]);
        due[1].callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

test("annotation flush gate resets trailing idle on strokes and sends no per-stroke update", async () => {
  const clock = fakeClock();
  const reasons: string[] = [];
  const gate = new AnnotationFlushGate(async (_surface, _pane, reason) => {
    reasons.push(reason);
  }, (error) => { throw error; }, clock.now, 5_000, 10_000, clock.scheduler);
  gate.strokeEnded("surface", 1);
  await clock.advance(4_000);
  assert.deepEqual(reasons, []);
  gate.strokeEnded("surface", 1);
  await clock.advance(4_000);
  assert.deepEqual(reasons, []);
  await clock.advance(1_000);
  assert.deepEqual(reasons, ["idle_window"]);
  await clock.advance(10_000);
  assert.deepEqual(reasons, ["idle_window"], "clean state sends nothing");
  gate.stop();
});

test("annotation flush gate forces continuous dirty work at maximum interval", async () => {
  const clock = fakeClock();
  const reasons: string[] = [];
  const gate = new AnnotationFlushGate(async (_surface, _pane, reason) => {
    reasons.push(reason);
  }, (error) => { throw error; }, clock.now, 5_000, 10_000, clock.scheduler);
  gate.strokeEnded("surface", 1);
  await clock.advance(4_000);
  gate.strokeEnded("surface", 1);
  await clock.advance(4_000);
  gate.strokeEnded("surface", 1);
  await clock.advance(2_000);
  assert.deepEqual(reasons, ["max_interval"]);
  gate.stop();
});
