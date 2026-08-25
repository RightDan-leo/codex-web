import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_PROGRESS_MAX_BYTES,
  REMOTE_PROGRESS_MAX_EVENTS,
  REMOTE_RESULT_MAX_BYTES,
  validateServerMessage,
  validateWorkerMessage,
} from "../server/remote-worker-protocol.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { RemoteWorkerRuntime } from "../server/remote-worker-runtime.js";

const hello = {
  type: "worker.hello" as const,
  protocolVersion: 1 as const,
  workerId: "hardening-worker",
  displayName: "Hardening Worker",
  capabilities: {
    platform: "linux" as const,
    arch: "x64",
    supportsSteering: true,
    supportsInterrupt: true,
  },
  projects: [{ id: "hardening-project", name: "Hardening Project" }],
};

test("worker protocol rejects server paths, extra fields, and oversized events", () => {
  assert.throws(() => validateServerMessage({
    type: "server.run",
    protocolVersion: 1,
    requestId: "request-path",
    jobId: "job-path",
    projectId: "hardening-project",
    prompt: "work",
    cwd: "C:\\server-controlled",
  }), /Unexpected field/);

  assert.throws(() => validateWorkerMessage({
    type: "worker.progress",
    protocolVersion: 1,
    requestId: "request-progress",
    jobId: "job-progress",
    payload: { detail: "x".repeat(REMOTE_PROGRESS_MAX_BYTES) },
  }), /size limit/);

  assert.throws(() => validateWorkerMessage({
    type: "worker.result",
    protocolVersion: 1,
    requestId: "request-result",
    jobId: "job-result",
    result: "x".repeat(REMOTE_RESULT_MAX_BYTES + 1),
  }), /Invalid remote result/);
});

test("gateway binds every response to both request and job ids", async () => {
  const sent: Array<{ requestId: string }> = [];
  const gateway = new RemoteWorkerGateway();
  gateway.attach(hello, { send: (message) => sent.push(message) });
  const execution = gateway.start({ jobId: "job-bound", projectId: "hardening-project", prompt: "work" });
  assert.throws(() => gateway.receive("hardening-worker", {
    type: "worker.result",
    protocolVersion: 1,
    requestId: sent[0].requestId,
    jobId: "job-other",
    result: "wrong",
  }), /job id does not match/);
  gateway.receive("hardening-worker", {
    type: "worker.result",
    protocolVersion: 1,
    requestId: sent[0].requestId,
    jobId: "job-bound",
    result: "right",
  });
  assert.equal(await execution.result, "right");
});

test("gateway rejects a mismatched ready identity and settles transport send failures", () => {
  const gateway = new RemoteWorkerGateway();
  gateway.attach(hello, { send: () => { throw new Error("transport unavailable"); } });
  assert.throws(() => gateway.receive("hardening-worker", {
    type: "worker.ready",
    protocolVersion: 1,
    workerId: "different-worker",
  }), /identity does not match/);
  assert.throws(() => gateway.start({
    jobId: "job-send-failure",
    projectId: "hardening-project",
    prompt: "work",
  }), /transport unavailable/);
});

test("gateway bounds progress event count for each run", async () => {
  const sent: Array<{ requestId: string }> = [];
  const gateway = new RemoteWorkerGateway();
  gateway.attach(hello, { send: (message) => sent.push(message) });
  const execution = gateway.start({ jobId: "job-progress-budget", projectId: "hardening-project", prompt: "work" });
  const rejected = assert.rejects(execution.result, /too many progress updates/);
  for (let index = 0; index <= REMOTE_PROGRESS_MAX_EVENTS; index += 1) {
    gateway.receive("hardening-worker", {
      type: "worker.progress",
      protocolVersion: 1,
      requestId: sent[0].requestId,
      jobId: "job-progress-budget",
      payload: { index },
    });
  }
  await rejected;
});

test("steering acknowledgements time out without leaking pending commands", async () => {
  const gateway = new RemoteWorkerGateway({ commandTimeoutMs: 20 });
  const sent: Array<{ type: string; requestId: string }> = [];
  gateway.attach(hello, { send: (message) => sent.push(message) });
  const execution = gateway.start({ jobId: "job-timeout", projectId: "hardening-project", prompt: "work" });
  await assert.rejects(execution.steer("change"), /timed out/);
  gateway.receive("hardening-worker", {
    type: "worker.result",
    protocolVersion: 1,
    requestId: sent[0].requestId,
    jobId: "job-timeout",
    result: "done",
  });
  assert.equal(await execution.result, "done");
});

test("local cancellation settles immediately and ignores a late worker result", async () => {
  const sent: Array<{ type: string; requestId: string }> = [];
  const gateway = new RemoteWorkerGateway();
  gateway.attach(hello, { send: (message) => sent.push(message) });
  const execution = gateway.start({ jobId: "job-cancel-local", projectId: "hardening-project", prompt: "work" });
  const runRequestId = sent[0].requestId;
  execution.interrupt();
  await assert.rejects(execution.result, (error: Error) => error.name === "AbortError");
  assert.equal(sent[1].type, "server.cancel");
  assert.doesNotThrow(() => gateway.receive("hardening-worker", {
    type: "worker.result",
    protocolVersion: 1,
    requestId: runRequestId,
    jobId: "job-cancel-local",
    result: "late",
  }));
});

test("runtime cancellation remains final when the local interrupt throws", async () => {
  let finish!: (value: string) => void;
  const result = new Promise<string>((resolve) => { finish = resolve; });
  const runtime = new RemoteWorkerRuntime([
    { id: "hardening-project", name: "Hardening Project", cwd: "/tmp/hardening" },
  ], () => ({ result, interrupt: () => { throw new Error("already exited"); } }));
  const emitted: Array<{ type: string }> = [];
  const handling = runtime.handle({
    type: "server.run",
    protocolVersion: 1,
    requestId: "request-runtime-cancel",
    jobId: "job-runtime-cancel",
    projectId: "hardening-project",
    prompt: "work",
  }, (message) => emitted.push(message));
  await Promise.resolve();
  await runtime.handle({
    type: "server.cancel",
    protocolVersion: 1,
    requestId: "cancel-runtime",
    jobId: "job-runtime-cancel",
  }, (message) => emitted.push(message));
  finish("late");
  await handling;
  assert.equal(emitted.some((message) => message.type === "worker.cancelled"), true);
  assert.equal(emitted.some((message) => message.type === "worker.result"), false);
  assert.equal(await runtime.waitForIdle(50), true);
});
