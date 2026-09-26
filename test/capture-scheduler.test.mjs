import assert from "node:assert/strict";
import test from "node:test";
import { createCaptureScheduler } from "../extension/core/capture-scheduler.js";

function clock() {
  let time = 0;
  let next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (callback, delay) => { const id = ++next; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimer: (id) => timers.delete(id),
    async advance(duration) {
      const end = time + duration;
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry;
        timers.delete(id); time = timer.at; timer.callback();
        for (let n = 0; n < 5; n++) await Promise.resolve();
      }
      time = end;
      for (let n = 0; n < 5; n++) await Promise.resolve();
    }
  };
}

test("no-op clicks do not capture and rapid changes settle once after the default delay", async () => {
  const time = clock(); const captures = [];
  const scheduler = createCaptureScheduler({ ...time, capture: async (candidate) => captures.push(candidate) });
  assert.equal(scheduler.offer({ id: "inactive" }, { changed: true }), false);
  scheduler.setEnabled(true);
  assert.equal(scheduler.offer({ id: "noop" }), false);
  scheduler.offer({ id: "first" }, { changed: true });
  await time.advance(400);
  scheduler.offer({ id: "latest" }, { changed: true });
  await time.advance(499); assert.equal(captures.length, 0);
  await time.advance(1); assert.deepEqual(captures, [{ id: "latest" }]);
});

test("a zero configured delay still throttles captures to at most two per second", async () => {
  const time = clock(); const starts = [];
  const scheduler = createCaptureScheduler({ ...time, delayMs: 0, minIntervalMs: 0, capture: async () => starts.push(time.now()) });
  scheduler.setEnabled(true);
  scheduler.offer({}, { changed: true }); await time.advance(0);
  scheduler.offer({}, { changed: true }); await time.advance(499);
  assert.deepEqual(starts, [0]); await time.advance(1); assert.deepEqual(starts, [0, 500]);
});

test("slow capture has one latest pending candidate and never overlaps capture calls", async () => {
  const time = clock(); const captured = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createCaptureScheduler({ ...time, delayMs: 0, capture: async (candidate) => { captured.push(candidate.id); if (candidate.id === "first") await gate; } });
  scheduler.setEnabled(true);
  scheduler.offer({ id: "first" }, { changed: true }); await time.advance(0);
  scheduler.offer({ id: "middle" }, { changed: true });
  scheduler.offer({ id: "latest" }, { changed: true }); await time.advance(1000);
  assert.deepEqual(captured, ["first"]); assert.equal(scheduler.busy, true);
  release(); await time.advance(0); await time.advance(0);
  assert.deepEqual(captured, ["first", "latest"]);
});

test("pause cancels pending captures and invalidates an in-flight capture token", async () => {
  const time = clock(); let current;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createCaptureScheduler({ ...time, delayMs: 0, capture: async (_, context) => { current = context.isCurrent; await gate; } });
  scheduler.setEnabled(true); scheduler.offer({}, { changed: true }); await time.advance(0);
  assert.equal(current(), true);
  scheduler.offer({ id: "cancelled" }, { changed: true }); scheduler.setEnabled(false);
  assert.equal(current(), false); assert.equal(scheduler.hasPending, false);
  scheduler.setEnabled(true); assert.equal(current(), false);
  release(); await time.advance(1000); assert.equal(scheduler.busy, false);
});

test("capture failure is reported and later clicks can still capture", async () => {
  const time = clock(); const errors = []; let calls = 0;
  const scheduler = createCaptureScheduler({ ...time, delayMs: 0, capture: async () => { if (++calls === 1) throw new Error("platform capture limit"); }, onError: (error) => errors.push(error.message) });
  scheduler.setEnabled(true); scheduler.offer({}, { changed: true }); await time.advance(0);
  assert.deepEqual(errors, ["platform capture limit"]);
  scheduler.offer({}, { changed: true }); await time.advance(500); assert.equal(calls, 2);
});

test("bad timing settings are rejected", () => {
  for (const delayMs of [-1, Infinity, NaN, 2147483648]) assert.throws(() => createCaptureScheduler({ capture() {}, delayMs }), /timing/);
});
