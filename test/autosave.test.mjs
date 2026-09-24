import assert from "node:assert/strict";
import test from "node:test";

import { createAutosave, SAVE_STATUS } from "../extension/core/autosave.js";

function manualTimers() {
  const timers = new Map();
  let nextId = 0;

  return {
    setTimer(callback) {
      timers.set(++nextId, callback);
      return nextId;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    fire() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
    get size() {
      return timers.size;
    }
  };
}

function setup({ save } = {}) {
  const timers = manualTimers();
  const statuses = [];
  const saved = [];
  const autosave = createAutosave({
    save: save ?? (async (value) => saved.push(value)),
    onStatus: (status) => statuses.push(status),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  return { autosave, timers, statuses, saved };
}

test("edits are debounced into one save of the latest value", async () => {
  const { autosave, timers, statuses, saved } = setup();

  autosave.schedule("a");
  autosave.schedule("ab");
  autosave.schedule("abc");

  assert.equal(timers.size, 1);
  assert.equal(autosave.status, SAVE_STATUS.saving);

  timers.fire();
  assert.equal(await autosave.flush(), true);

  assert.deepEqual(saved, ["abc"]);
  assert.deepEqual(statuses, [SAVE_STATUS.saving, SAVE_STATUS.saved]);
});

test("an edit made during a save is written after it", async () => {
  let release;
  const saved = [];
  const { autosave, timers } = setup({
    save: async (value) => {
      if (value === "first") {
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      saved.push(value);
    }
  });

  autosave.schedule("first");
  timers.fire();
  await Promise.resolve();
  autosave.schedule("second");
  release();

  assert.equal(await autosave.flush(), true);
  assert.deepEqual(saved, ["first", "second"]);
  assert.equal(autosave.status, SAVE_STATUS.saved);
});

test("a failed save reports Storage unavailable and holds edits until retry", async () => {
  let fail = true;
  const saved = [];
  const { autosave, timers, statuses } = setup({
    save: async (value) => {
      if (fail) {
        throw new DOMException("gone", "NotFoundError");
      }
      saved.push(value);
    }
  });

  autosave.schedule("v1");
  timers.fire();

  assert.equal(await autosave.flush(), false);
  assert.equal(autosave.status, SAVE_STATUS.unavailable);
  assert.equal(autosave.lastError.name, "NotFoundError");
  assert.equal(autosave.hasPendingChanges, true);

  // Later edits are kept but not written while storage is unavailable.
  autosave.schedule("v2");
  assert.equal(timers.size, 0);
  assert.equal(await autosave.flush(), false);
  assert.deepEqual(saved, []);
  assert.equal(statuses.includes(SAVE_STATUS.saved), false);

  fail = false;
  assert.equal(await autosave.retry(), true);
  assert.deepEqual(saved, ["v2"]);
  assert.equal(autosave.status, SAVE_STATUS.saved);
  assert.equal(autosave.hasPendingChanges, false);
});

test("suspend holds edits in memory until resume", async () => {
  const { autosave, timers, saved } = setup();

  await autosave.suspend();
  autosave.schedule("held");

  assert.equal(timers.size, 0);
  assert.equal(await autosave.flush(), true);
  assert.deepEqual(saved, []);
  assert.equal(autosave.status, SAVE_STATUS.saving);
  assert.equal(autosave.hasPendingChanges, true);

  assert.equal(await autosave.resume(), true);
  assert.deepEqual(saved, ["held"]);
  assert.equal(autosave.status, SAVE_STATUS.saved);
});
