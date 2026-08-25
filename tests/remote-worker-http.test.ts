import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { installRemoteWorkerHttpRoutes } from "../server/remote-worker-http.js";

const token = "remote-worker-test-token-at-least-32-characters";
const hello = {
  type: "worker.hello" as const,
  protocolVersion: 1 as const,
  workerId: "http-worker",
  displayName: "HTTP Worker",
  capabilities: {
    platform: "linux" as const,
    arch: "x64",
    supportsSteering: true,
    supportsInterrupt: true,
  },
  projects: [{ id: "project-http", name: "HTTP Project" }],
};

function createTestService() {
  const app = express();
  app.use(express.json());
  const service = installRemoteWorkerHttpRoutes(app, { token, path: "/codex-worker" });
  return { app, service };
}

test("remote worker HTTP transport requires bearer authentication", async () => {
  const { app, service } = createTestService();
  try {
    await request(app).post("/codex-worker/register").send(hello).expect(401);
    await request(app).post("/codex-worker/register")
      .set("Authorization", "Bearer wrong-token")
      .send(hello)
      .expect(401);
  } finally { service.close(); }
});

test("remote worker HTTP transport carries a complete run round trip", async () => {
  const { app, service } = createTestService();
  try {
    const registered = await request(app).post("/codex-worker/register")
      .set("Authorization", `Bearer ${token}`)
      .send(hello)
      .expect(201);
    const sessionId = String(registered.body.sessionId);
    assert.ok(sessionId);

    const execution = service.gateway.start({ jobId: "job-http", projectId: "project-http", prompt: "change a file" });
    const polled = await request(app).get(`/codex-worker/poll/${sessionId}`)
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json")
      .expect(200);
    const run = polled.body.message as { type: string; requestId: string; jobId: string; projectId: string; cwd?: string };
    assert.equal(run.type, "server.run");
    assert.equal(run.projectId, "project-http");
    assert.equal("cwd" in run, false);

    await request(app).post(`/codex-worker/message/${sessionId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "worker.result",
        protocolVersion: 1,
        requestId: run.requestId,
        jobId: run.jobId,
        result: "http complete",
      })
      .expect(204);
    assert.equal(await execution.result, "http complete");

    const status = await request(app).get("/codex-worker/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    assert.equal(status.body.workers[0].workerId, "http-worker");
  } finally { service.close(); }
});

test("remote worker HTTP service rejects weak shared tokens", () => {
  const app = express();
  assert.throws(() => installRemoteWorkerHttpRoutes(app, { token: "too-short" }), /at least 32 characters/);
});
