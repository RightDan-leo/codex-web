import assert from "node:assert/strict";
import test from "node:test";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { RemoteWorkerPollingHub } from "../server/remote-worker-polling.js";

const hello = {
  type: "worker.hello" as const,
  protocolVersion: 1 as const,
  workerId: "worker-polling",
  displayName: "Polling Worker",
  capabilities: {
    platform: "linux" as const,
    arch: "x64",
    supportsSteering: true,
    supportsInterrupt: true,
  },
  projects: [{ id: "project-a", name: "Project A" }],
};

test("polling transport carries gateway run and result messages", async () => {
  const gateway = new RemoteWorkerGateway();
  const hub = new RemoteWorkerPollingHub(gateway);
  const { sessionId } = hub.register(hello);

  const execution = gateway.start({ jobId: "job-poll", projectId: "project-a", prompt: "do work" });
  const message = await hub.poll(sessionId);
  assert.equal(message?.type, "server.run");
  if (!message || message.type !== "server.run") throw new Error("Expected remote run message");
  assert.equal(message.projectId, "project-a");
  assert.equal("cwd" in message, false);

  hub.receive(sessionId, {
    type: "worker.result",
    protocolVersion: 1,
    requestId: message.requestId,
    jobId: message.jobId,
    result: "remote result",
  });
  assert.equal(await execution.result, "remote result");
});

test("idle polling session detaches worker and rejects in-flight work", async () => {
  let now = 1_000;
  const gateway = new RemoteWorkerGateway();
  const hub = new RemoteWorkerPollingHub(gateway, { sessionTtlMs: 10_000, now: () => now });
  hub.register(hello);
  const execution = gateway.start({ jobId: "job-expire", projectId: "project-a", prompt: "long work" });

  now += 10_001;
  assert.equal(hub.sweepIdle(), 1);
  await assert.rejects(execution.result, /session expired/);
  assert.equal(gateway.hasProject("project-a"), false);
});

test("worker reconnect replaces its previous polling session", async () => {
  const gateway = new RemoteWorkerGateway();
  const hub = new RemoteWorkerPollingHub(gateway);
  const first = hub.register(hello);
  const second = hub.register(hello);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.throws(() => hub.receive(first.sessionId, { type: "worker.pong", protocolVersion: 1, requestId: "old:1" }), /Unknown remote worker polling session/);
  assert.equal(gateway.hasProject("project-a"), true);
});

test("cancelled long polls release their waiter and allow a replacement", async () => {
  const gateway = new RemoteWorkerGateway();
  const hub = new RemoteWorkerPollingHub(gateway);
  const { sessionId } = hub.register(hello);
  const first = hub.poll(sessionId);
  assert.equal(hub.cancelPoll(sessionId), true);
  assert.equal(await first, null);

  const replacement = hub.poll(sessionId);
  const execution = gateway.start({ jobId: "job-after-cancelled-poll", projectId: "project-a", prompt: "work" });
  const run = await replacement;
  assert.equal(run?.type, "server.run");
  execution.interrupt();
  await assert.rejects(execution.result, /cancelled/i);
  hub.close();
});

test("a replaced session cannot complete an in-flight job", async () => {
  const gateway = new RemoteWorkerGateway();
  const hub = new RemoteWorkerPollingHub(gateway);
  const first = hub.register(hello);
  const execution = gateway.start({ jobId: "job-stale-session", projectId: "project-a", prompt: "work" });
  const run = await hub.poll(first.sessionId);
  assert.equal(run?.type, "server.run");
  hub.register(hello);
  await assert.rejects(execution.result, /reconnected/i);
  assert.throws(() => hub.receive(first.sessionId, {
    type: "worker.result",
    protocolVersion: 1,
    requestId: run!.requestId,
    jobId: "job-stale-session",
    result: "late completion",
  }), /Unknown remote worker polling session/);
});
