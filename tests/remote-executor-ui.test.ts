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
  assertRemoteAttachmentsSupported,
  forgetExecutorTarget,
  knownExecutorTarget,
  rememberExecutorTarget,
} from "../src/remote-executor-state.js";

const workers = [{
  workerId: "windows-pc",
  displayName: "Development PC",
  connectedAt: 1,
  projects: [{ id: "magic-zombie", name: "MagicZombie" }],
}];

test("executor values round-trip without exposing a local path", () => {
  assert.deepEqual(parseExecutorValue("tenant"), { kind: "tenant" });
  assert.deepEqual(parseExecutorValue("remote:magic-zombie"), { kind: "remote", projectId: "magic-zombie" });
  assert.equal(parseExecutorValue("remote:"), null);
  assert.equal(executorValue({ kind: "remote", projectId: "magic-zombie" }), "remote:magic-zombie");
});

test("executor options keep the tenant default and preserve an offline selection", () => {
  const online = buildExecutorOptions(workers, { kind: "remote", projectId: "magic-zombie" });
  assert.equal(online[0].value, "tenant");
  assert.equal(online[1].label, "MagicZombie");
  assert.equal(online[1].description, "Development PC · 远端项目在线");
  assert.equal(JSON.stringify(online).includes("D:\\"), false);

  const offline = buildExecutorOptions([], { kind: "remote", projectId: "magic-zombie" });
  assert.equal(offline.length, 2);
  assert.equal(offline[1].online, false);
  assert.match(offline[1].description, /离线/);
});

test("executor summary reports online and fail-closed offline state", () => {
  assert.equal(executorIsOnline({ kind: "remote", projectId: "magic-zombie" }, workers), true);
  assert.equal(executorIsOnline({ kind: "remote", projectId: "missing" }, workers), false);
  assert.deepEqual(executorSummary({ kind: "tenant" }, workers), {
    label: "隔离工作区", description: "服务器容器", online: true,
  });
  assert.equal(executorSummary({ kind: "remote", projectId: "missing" }, workers).online, false);
});

test("known remote executor blocks browser attachment staging", () => {
  const id = "conversation-1";
  rememberExecutorTarget(id, { kind: "remote", projectId: "magic-zombie" });
  assert.deepEqual(knownExecutorTarget(id), { kind: "remote", projectId: "magic-zombie" });
  assert.throws(() => assertRemoteAttachmentsSupported(id, 1), /暂不支持网页附件/);
  assert.doesNotThrow(() => assertRemoteAttachmentsSupported(id, 0));
  rememberExecutorTarget(id, { kind: "tenant" });
  assert.doesNotThrow(() => assertRemoteAttachmentsSupported(id, 2));
  forgetExecutorTarget(id);
  assert.equal(knownExecutorTarget(id), undefined);
});
