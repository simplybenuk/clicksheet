import assert from "node:assert/strict";
import test from "node:test";
import { JOURNEY_STATE, journeyControls, prepareJourney, transitionJourney } from "../extension/core/journey.js";

const ready = () => ({ id: "j1", name: "Checkout", settings: { captureDelayMs: 500 }, frames: [{ id: "f1", label: "Manual Capture" }] });
const capable = { available: true, captureReady: true };
const transition = (journey, action) => transitionJourney(journey, action, capable);

test("old Journey metadata defaults to Ready without changing or sharing its data", () => {
  const original = ready();
  const prepared = prepareJourney(original);
  assert.equal(prepared.state, JOURNEY_STATE.ready);
  assert.equal(prepared.recordingSegment, 0);
  assert.equal(prepared.pauseReason, null);
  prepared.frames[0].label = "Changed";
  prepared.settings.captureDelayMs = 100;
  assert.equal(original.frames[0].label, "Manual Capture");
  assert.equal(original.settings.captureDelayMs, 500);
  assert.equal(original.state, undefined);
});

test("Record, Pause, Resume, Stop and Record preserve frames and append a segment", () => {
  const original = ready();
  const recording = transition(original, "record");
  assert.equal(recording.state, "Recording");
  assert.equal(recording.recordingSegment, 1);
  const paused = transition(recording, "pause");
  assert.equal(paused.state, "Paused");
  assert.equal(paused.pauseReason, "user");
  const resumed = transition(paused, "resume");
  assert.equal(resumed.state, "Recording");
  assert.equal(resumed.recordingSegment, 1);
  const stopped = transition(resumed, "stop");
  assert.equal(stopped.state, "Stopped");
  const appended = transition(stopped, "record");
  assert.equal(appended.recordingSegment, 2);
  assert.deepEqual(appended.frames, original.frames);
  assert.equal(appended.id, original.id);
  assert.equal(transition(paused, "stop").state, "Stopped");
  assert.equal(recording.state, "Recording");
});

test("only a tab pause automatically resumes on tab return", () => {
  const recording = transition(ready(), "record");
  const tabPaused = transition(recording, "tab-away");
  assert.equal(tabPaused.pauseReason, "tab");
  assert.equal(transition(tabPaused, "tab-returned").state, "Recording");
  for (const action of ["pause", "permission-lost", "storage-unavailable", "navigation"]) {
    const paused = transition(recording, action);
    assert.equal(transition(transition(paused, "tab-away"), "tab-returned").state, "Paused");
  }
  for (const action of ["permission-lost", "storage-unavailable", "navigation"]) {
    const paused = transition(tabPaused, action);
    assert.notEqual(paused.pauseReason, "tab");
    assert.equal(transition(paused, "tab-returned").state, "Paused");
  }
  assert.equal(transitionJourney(tabPaused, "tab-returned").state, "Paused");
});

test("controls allow manual capture in every state and library switching only when idle", () => {
  const recording = transition(ready(), "record");
  const states = [prepareJourney(ready()), recording, transition(recording, "pause"), transition(recording, "stop")];
  for (const journey of states) {
    const controls = journeyControls(journey, capable);
    assert.equal(controls.capture, true);
    assert.equal(controls.rename, true);
    assert.equal(controls.newJourney, ["Ready", "Stopped"].includes(journey.state));
    assert.equal(controls.openJourney, controls.newJourney);
    const captured = transition(journey, "capture");
    assert.equal(captured.state, journey.state);
    assert.deepEqual(captured.frames, journey.frames, "model does not invent a captured frame");
  }
  assert.equal(journeyControls(null, capable).newJourney, true);
  assert.equal(journeyControls(null, capable).record, false);
});

test("capture controls require actual capture readiness and writable storage", () => {
  const recording = transition(ready(), "record");
  for (const options of [{}, { available: false, captureReady: true }]) {
    const controls = journeyControls(recording, options);
    assert.equal(controls.capture, false);
    assert.equal(controls.pause, true);
    assert.equal(controls.stop, true);
    assert.equal(controls.rename, true);
    assert.throws(() => transitionJourney(ready(), "record", options), /unavailable/);
    assert.throws(() => transitionJourney(recording, "capture", options), /unavailable/);
  }
  assert.equal(journeyControls(ready(), { available: false }).newJourney, false);
});

test("invalid transitions and malformed metadata are refused", () => {
  for (const action of ["pause", "resume", "stop"]) assert.throws(() => transition(ready(), action), /unavailable/);
  const recording = transition(ready(), "record");
  assert.throws(() => transition(recording, "record"), /unavailable/);
  assert.throws(() => transition(recording, "typo"), /Unknown Journey action/);
  for (const change of [{ state: "Unknown" }, { recordingSegment: -1 }, { recordingSegment: 1.5 },
    { state: "Paused" }, { pauseReason: "user" }, { state: "Paused", pauseReason: "invalid" }, { frames: null }]) {
    assert.throws(() => prepareJourney({ ...ready(), ...change }), TypeError);
  }
  assert.throws(() => transition({ ...ready(), recordingSegment: Number.MAX_SAFE_INTEGER }, "record"), /limit reached/);
});
