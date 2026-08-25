import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-taskboard-api-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    dataRoot: path.join(root, "data"),
    tenantRoot,
    workspaceRoot: path.join(root, "workspaces"),
    username: "owner",
    displayName: "Owner",
    passwordHash: bcrypt.hashSync("Owner-Taskboard-2026!", 8),
    sessionSecret: "taskboard-api-session-secret-at-least-32-characters",
    queueAutoStart: false,
  });
  const now = new Date().toISOString();
  instance.db.createUser({
    id: crypto.randomUUID(),
    username: "member",
    display_name: "Member",
    password_hash: bcrypt.hashSync("Member-Taskboard-2026!", 8),
    role: "member",
    status: "active",
    created_at: now,
    updated_at: now,
  });
  t.after(() => {
    instance.db.sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return instance;
}

test("taskboard API enforces login, owner role, CSRF and origin", async (t) => {
  const instance = setup(t);
  const owner = request.agent(instance.app);
  const member = request.agent(instance.app);
  const ownerLogin = await owner.post("/codex-web/api/auth/login")
    .send({ username: "owner", password: "Owner-Taskboard-2026!" }).expect(200);
  const memberLogin = await member.post("/codex-web/api/auth/login")
    .send({ username: "member", password: "Member-Taskboard-2026!" }).expect(200);

  await request(instance.app).get("/codex-web/api/taskboard/projects").expect(401);
  await member.get("/codex-web/api/taskboard/projects").expect(403);
  await member.post("/codex-web/api/taskboard/projects")
    .set("X-CSRF-Token", memberLogin.body.csrfToken)
    .send({ name: "Denied", executor: { kind: "tenant" } }).expect(403);
  await owner.post("/codex-web/api/taskboard/projects")
    .send({ name: "No CSRF", executor: { kind: "tenant" } }).expect(403);
  await owner.post("/codex-web/api/taskboard/projects")
    .set("X-CSRF-Token", ownerLogin.body.csrfToken)
    .set("Origin", "https://evil.example")
    .send({ name: "Spoofed", executor: { kind: "tenant" } }).expect(403);
});

test("owner can create a project and move a task through the review gate", async (t) => {
  const instance = setup(t);
  const owner = request.agent(instance.app);
  const login = await owner.post("/codex-web/api/auth/login")
    .send({ username: "owner", password: "Owner-Taskboard-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  const createdProject = await owner.post("/codex-web/api/taskboard/projects")
    .set("X-CSRF-Token", csrf)
    .send({ name: "Product", description: "MVP", executor: { kind: "tenant" } }).expect(201);
  const project = createdProject.body.project as { id: string; version: number };
  const createdTask = await owner.post(`/codex-web/api/taskboard/projects/${project.id}/tasks`)
    .set("X-CSRF-Token", csrf)
    .send({ title: "Build board", priority: "high", risk: "low", acceptanceCriteria: "All tests pass" }).expect(201);
  let task = createdTask.body.task as { id: string; version: number; status: string };

  await owner.post(`/codex-web/api/taskboard/tasks/${task.id}/transition`)
    .set("X-CSRF-Token", csrf).send({ version: task.version, status: "done" }).expect(400);
  for (const status of ["ready", "running", "review", "done"] as const) {
    const response = await owner.post(`/codex-web/api/taskboard/tasks/${task.id}/transition`)
      .set("X-CSRF-Token", csrf).send({ version: task.version, status }).expect(200);
    task = response.body.task;
  }
  assert.equal(task.status, "done");

  const detail = await owner.get(`/codex-web/api/taskboard/projects/${project.id}`).expect(200);
  assert.equal(detail.body.tasks.length, 1);
  assert.equal(detail.body.tasks[0].status, "done");
  const events = await owner.get(`/codex-web/api/taskboard/tasks/${task.id}/events`).expect(200);
  assert.ok(events.body.events.some((event: { event_type: string }) => event.event_type === "task.transitioned"));

  const archived = await owner.delete(`/codex-web/api/taskboard/tasks/${task.id}`)
    .set("X-CSRF-Token", csrf).send({ version: task.version }).expect(200);
  assert.ok(archived.body.task.archivedAt);
  const afterArchive = await owner.get(`/codex-web/api/taskboard/projects/${project.id}`).expect(200);
  assert.equal(afterArchive.body.tasks.length, 0);
});

test("remote taskboard projects require a currently advertised logical project id", async (t) => {
  const instance = setup(t);
  const owner = request.agent(instance.app);
  const login = await owner.post("/codex-web/api/auth/login")
    .send({ username: "owner", password: "Owner-Taskboard-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  await owner.post("/codex-web/api/taskboard/projects")
    .set("X-CSRF-Token", csrf)
    .send({ name: "Offline", executor: { kind: "remote", projectId: "offline-project" } }).expect(409);

  instance.remoteWorkerGateway.attach({
    type: "worker.hello",
    protocolVersion: 1,
    workerId: "taskboard-worker",
    displayName: "Taskboard Worker",
    capabilities: {
      platform: "win32",
      arch: "x64",
      supportsSteering: true,
      supportsInterrupt: true,
    },
    projects: [{ id: "online-project", name: "Online Project" }],
  }, { send: () => undefined });
  const created = await owner.post("/codex-web/api/taskboard/projects")
    .set("X-CSRF-Token", csrf)
    .send({ name: "Online", executor: { kind: "remote", projectId: "online-project" } }).expect(201);
  assert.deepEqual(created.body.project.executor, { kind: "remote", projectId: "online-project" });
});
