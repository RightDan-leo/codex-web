import assert from "node:assert/strict";
import test from "node:test";
import { canTransitionTask, transitionTargets } from "../server/taskboard-policy.js";

test("taskboard state machine requires review before owner completion", () => {
  assert.equal(canTransitionTask("backlog", "done"), false);
  assert.equal(canTransitionTask("ready", "done"), false);
  assert.equal(canTransitionTask("running", "done"), false);
  assert.equal(canTransitionTask("review", "done"), true);
  assert.deepEqual(transitionTargets("done"), []);
});

test("blocked and cancelled tasks cannot silently enter running", () => {
  assert.equal(canTransitionTask("blocked", "running"), false);
  assert.equal(canTransitionTask("blocked", "ready"), true);
  assert.equal(canTransitionTask("cancelled", "running"), false);
});
