import assert from "node:assert/strict";
import test from "node:test";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";

const hello = {
  type: "worker.hello" as const,
  protocolVersion: 1 as const,
  workerId: "steer-worker",
  displayName: "Steer Worker",
  capabilities: {
    platform: "linux" as const,
    arch: "x64",
    supportsSteering: true,
    supportsInterrupt: true,
  },
  projects: [{ id: "project-steer", name: "Steer Project" }],
};

test("successful steering resolves only after worker acknowledgement", async () => {
  const gateway = new RemoteWorkerGateway();
  const sent: Array<{ type: string; requestId: string; jobId?: string }> = [];
  gateway.attach(hello, { send: (message) => sent.push(message) });
  const execution = gateway.start({ jobId: "job-steer-ok", projectId: "project-steer", prompt: "start" });
  const steering = execution.steer("change direction");
  const steer = sent[1];
  assert.equal(steer.type, "server.steer");
  gateway.receive("steer-worker", {
    type: "worker.steered",
    protocolVersion: 1,
    requestId: steer.requestId,
    jobId: "job-steer-ok",
    turnId: "turn-steered",
  });
  assert.equal(await steering, "turn-steered");

  const run = sent[0];
  gateway.receive("steer-worker", {
    type: "worker.result",
    protocolVersion: 1,
    requestId: run.requestId,
    jobId: "job-steer-ok",
    result: "main run completed",
  });
  assert.equal(await execution.result, "main run completed");
});

test("steering command errors do not fail the active run", async () => {
  const gateway = new RemoteWorkerGateway();
  const sent: Array<{ type: string; requestId: string; jobId?: string }> = [];
  gateway.attach(hello, { send: (message) => sent.push(message) });
  const execution = gateway.start({ jobId: "job-steer", projectId: "project-steer", prompt: "start" });
  const run = sent[0];

  const steering = execution.steer("change direction");
  const steer = sent[1];
  assert.equal(steer.type, "server.steer");
  gateway.receive("steer-worker", {
    type: "worker.error",
    protocolVersion: 1,
    requestId: steer.requestId,
    jobId: "job-steer",
    message: "steer was rejected",
  });
  await assert.rejects(steering, /steer was rejected/);
  gateway.receive("steer-worker", {
    type: "worker.result",
    protocolVersion: 1,
    requestId: run.requestId,
    jobId: "job-steer",
    result: "main run completed",
  });
  assert.equal(await execution.result, "main run completed");
});
