import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutorOptions,
  executorIsOnline,
  executorSummary,
  executorValue,
  parseExecutorValue,
} from "../src/remote-executor.js";
import {
  forgetExecutorTarget,
  knownExecutorTarget,
  rememberExecutorTarget,
} from "../src/remote-executor-state.js";

const workers = [{
  workerId: "windows-pc",
  displayName: "Development PC",
  connectedAt: 1,
  projects: [{ id: "sample-project", name: "Sample Project" }],
}];

test("executor values round-trip without exposing a local path", () => {
  assert.deepEqual(parseExecutorValue("tenant"), { kind: "tenant" });
  assert.deepEqual(parseExecutorValue("remote:sample-project"), { kind: "remote", projectId: "sample-project" });
  assert.equal(parseExecutorValue("remote:"), null);
  assert.equal(executorValue({ kind: "remote", projectId: "sample-project" }), "remote:sample-project");
});

test("executor options keep the tenant default and preserve an offline selection", () => {
  const online = buildExecutorOptions(workers, { kind: "remote", projectId: "sample-project" });
  assert.equal(online[0].value, "tenant");
  assert.equal(online[1].label, "Sample Project");
  assert.equal(online[1].description, "Development PC · 远端项目在线");
  assert.equal(JSON.stringify(online).includes("D:\\"), false);

  const offline = buildExecutorOptions([], { kind: "remote", projectId: "sample-project" });
  assert.equal(offline.length, 2);
  assert.equal(offline[1].online, false);
  assert.match(offline[1].description, /离线/);
});

test("executor summary reports online and fail-closed offline state", () => {
  assert.equal(executorIsOnline({ kind: "remote", projectId: "sample-project" }, workers), true);
  assert.equal(executorIsOnline({ kind: "remote", projectId: "missing" }, workers), false);
  assert.deepEqual(executorSummary({ kind: "tenant" }, workers), {
    label: "隔离工作区", description: "服务器容器", online: true,
  });
  assert.equal(executorSummary({ kind: "remote", projectId: "missing" }, workers).online, false);
});

test("known executor state follows the selected conversation", () => {
  const id = "conversation-1";
  rememberExecutorTarget(id, { kind: "remote", projectId: "sample-project" });
  assert.deepEqual(knownExecutorTarget(id), { kind: "remote", projectId: "sample-project" });
  rememberExecutorTarget(id, { kind: "tenant" });
  assert.deepEqual(knownExecutorTarget(id), { kind: "tenant" });
  forgetExecutorTarget(id);
  assert.equal(knownExecutorTarget(id), undefined);
});
