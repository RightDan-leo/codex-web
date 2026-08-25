import assert from "node:assert/strict";
import test from "node:test";
import { canChangeExecutor } from "../server/remote-executor-policy.js";

const empty = {
  hasThread: false,
  messageCount: 0,
  activeJobCount: 0,
  queuedPromptCount: 0,
  editingPromptCount: 0,
  hasSavedDraft: false,
};

test("executor is selectable only before a draft or work is persisted", () => {
  assert.equal(canChangeExecutor(empty), true);
  assert.equal(canChangeExecutor({ ...empty, hasSavedDraft: true }), false);
});

test("executor locks after context or queued work begins", () => {
  assert.equal(canChangeExecutor({ ...empty, hasThread: true }), false);
  assert.equal(canChangeExecutor({ ...empty, messageCount: 1 }), false);
  assert.equal(canChangeExecutor({ ...empty, activeJobCount: 1 }), false);
  assert.equal(canChangeExecutor({ ...empty, queuedPromptCount: 1 }), false);
  assert.equal(canChangeExecutor({ ...empty, editingPromptCount: 1 }), false);
});
