import assert from "node:assert/strict";
import test from "node:test";
import { ExecutorRouter } from "../server/executor-router.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { RemoteWorkerRuntime } from "../server/remote-worker-runtime.js";

const hello = {
  type: "worker.hello" as const,
  protocolVersion: 1 as const,
  workerId: "macbook-pro",
  displayName: "MacBook Pro",
  capabilities: {
    platform: "darwin" as const,
    arch: "arm64",
    codexVersion: "0.149.1",
    supportsSteering: true,
    supportsInterrupt: true,
  },
  projects: [{ id: "magic-zombie", name: "MagicZombie" }],
};

test("gateway dispatches only to advertised remote projects", async () => {
  const gateway = new RemoteWorkerGateway();
  const sent: unknown[] = [];
  gateway.attach(hello, { send: (message) => sent.push(message) });
  assert.equal(gateway.hasProject("magic-zombie"), true);
  assert.throws(() => gateway.start({ jobId: "job-404", projectId: "unknown", prompt: "x" }), /No online remote worker/);

  let threadId = "";
  const progress: unknown[] = [];
  const execution = gateway.start({ jobId: "job-1", projectId: "magic-zombie", prompt: "fix login" }, {
    onThreadStarted: (value) => { threadId = value; },
    onProgress: (value) => progress.push(value),
  });
  const run = sent[0] as { type: string; requestId: string; projectId: string; cwd?: string };
  assert.equal(run.type, "server.run");
  assert.equal(run.projectId, "magic-zombie");
  assert.equal("cwd" in run, false);

  gateway.receive("macbook-pro", { type: "worker.thread.started", protocolVersion: 1, requestId: run.requestId, jobId: "job-1", threadId: "thread-1" });
  gateway.receive("macbook-pro", { type: "worker.progress", protocolVersion: 1, requestId: run.requestId, jobId: "job-1", payload: { kind: "status", label: "working" } });
  gateway.receive("macbook-pro", { type: "worker.result", protocolVersion: 1, requestId: run.requestId, jobId: "job-1", result: "done" });
  assert.equal(await execution.result, "done");
  assert.equal(threadId, "thread-1");
  assert.deepEqual(progress, [{ kind: "status", label: "working" }]);
});

test("runtime resolves project id to local cwd instead of accepting a server path", async () => {
  let receivedInput: { cwd: string; codexHome?: string } | undefined;
  let finish!: (value: string) => void;
  const result = new Promise<string>((resolve) => { finish = resolve; });
  const runtime = new RemoteWorkerRuntime([
    { id: "magic-zombie", name: "MagicZombie", cwd: "/Users/dan/Projects/MagicZombie", codexHome: "/Users/dan/.codex" },
  ], (input, callbacks) => {
    receivedInput = input;
    callbacks.onThreadStarted("local-thread");
    callbacks.onProgress({ kind: "status", label: "editing" });
    return { result, steer: async () => {}, interrupt: () => {} };
  });
  const emitted: Array<{ type: string; result?: string }> = [];
  const handling = runtime.handle({
    type: "server.run", protocolVersion: 1, requestId: "request-1", jobId: "job-1",
    projectId: "magic-zombie", prompt: "implement feature",
  }, (message) => emitted.push(message));
  await Promise.resolve();
  assert.equal(receivedInput?.cwd, "/Users/dan/Projects/MagicZombie");
  assert.equal(receivedInput?.codexHome, "/Users/dan/.codex");
  assert.equal(emitted[0].type, "worker.thread.started");
  assert.equal(emitted[1].type, "worker.progress");
  finish("finished locally");
  await handling;
  assert.equal(emitted.at(-1)?.type, "worker.result");
  assert.equal(emitted.at(-1)?.result, "finished locally");
});

test("runtime rejects projects that were not explicitly registered", async () => {
  let starts = 0;
  const runtime = new RemoteWorkerRuntime([], () => { starts += 1; return { result: Promise.resolve("no") }; });
  const emitted: Array<{ type: string; message?: string }> = [];
  await runtime.handle({
    type: "server.run", protocolVersion: 1, requestId: "request-2", jobId: "job-2",
    projectId: "etc-passwd", prompt: "read files",
  }, (message) => emitted.push(message));
  assert.equal(starts, 0);
  assert.equal(emitted[0].type, "worker.error");
  assert.match(emitted[0].message ?? "", /not registered/);
});

test("executor router preserves tenant default and requires explicit remote target", async () => {
  const calls: string[][] = [];
  const router = new ExecutorRouter(
    (input) => { calls.push(["tenant", input.jobId]); return { result: Promise.resolve("tenant"), steer() {}, interrupt() {} }; },
    (input) => { calls.push(["remote", input.projectId]); return { result: Promise.resolve("remote"), steer() {}, interrupt() {} }; },
  );
  assert.equal(await router.start({ kind: "tenant" }, { jobId: "a", prompt: "x" }).result, "tenant");
  assert.equal(await router.start({ kind: "remote", projectId: "magic-zombie" }, { jobId: "b", prompt: "y" }).result, "remote");
  assert.deepEqual(calls, [["tenant", "a"], ["remote", "magic-zombie"]]);
});
