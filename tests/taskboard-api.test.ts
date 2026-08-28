import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { safeExecutionMessage } from "../server/taskboard-api.js";

function setup(t: test.TestContext, queueAutoStart = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-taskboard-api-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    dataRoot: path.join(root, "data"),
    tenantRoot,
    workspaceRoot: path.join(root, "workspaces"),
    username: "task-owner",
    displayName: "Owner",
    passwordHash: bcrypt.hashSync("Owner-Taskboard-2026!", 8),
    sessionSecret: "taskboard-api-session-secret-at-least-32-characters",
    queueAutoStart,
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

function advertiseRemoteProject(
  t: test.TestContext,
  instance: ReturnType<typeof createApp>,
  projectId: string,
  executorId = `remote:${projectId}`,
) {
  const owner = instance.db.listUsers().find((user) => user.username === "task-owner")!;
  instance.db.createProject(projectId, owner.id, projectId, path.join(instance.config.tenantRoot, "..", "remote", projectId), executorId);
  const original = instance.remoteWorkers.executor.bind(instance.remoteWorkers);
  let online = true;
  instance.remoteWorkers.executor = ((id: string) => id === executorId
    ? ({ id, status: online ? "online" : "offline", machineName: projectId } as ReturnType<typeof original>)
    : original(id)) as typeof instance.remoteWorkers.executor;
  t.after(() => { instance.remoteWorkers.executor = original; });
  return { setOnline(value: boolean) { online = value; } };
}

test("taskboard execution messages classify failures without exposing raw details", () => {
  assert.equal(
    safeExecutionMessage("failed", "spawn EPERM at D:\\private\\project; token=secret"),
    "本机 Codex 运行程序无法启动；请检查 CODEX_RUNTIME_PATH 和 Windows 执行权限。",
  );
  assert.equal(
    safeExecutionMessage("failed", "Not logged in: C:\\Users\\owner\\.codex"),
    "当前执行器尚未登录 Codex；完成该执行器的登录后再重试。",
  );
  assert.doesNotMatch(safeExecutionMessage("failed", "unexpected token=secret")!, /secret|token=/i);
});

test("taskboard API enforces login, owner role, CSRF and origin", async (t) => {
  const instance = setup(t);
  const owner = request.agent(instance.app);
  const member = request.agent(instance.app);
  const ownerLogin = await owner.post("/api/auth/login")
    .send({ username: "task-owner", password: "Owner-Taskboard-2026!" }).expect(200);
  const memberLogin = await member.post("/api/auth/login")
    .send({ username: "member", password: "Member-Taskboard-2026!" }).expect(200);

  await request(instance.app).get("/api/taskboard/projects").expect(401);
  await member.get("/api/taskboard/projects").expect(403);
  await member.post("/api/taskboard/projects")
    .set("X-CSRF-Token", memberLogin.body.csrfToken)
    .send({ name: "Denied", executor: { kind: "tenant" } }).expect(403);
  await owner.post("/api/taskboard/projects")
    .send({ name: "No CSRF", executor: { kind: "tenant" } }).expect(403);
  await owner.post("/api/taskboard/projects")
    .set("X-CSRF-Token", ownerLogin.body.csrfToken)
    .set("Origin", "https://evil.example")
    .send({ name: "Spoofed", executor: { kind: "tenant" } }).expect(403);
});

test("owner can create a project and move a task through the review gate", async (t) => {
  const instance = setup(t);
  const owner = request.agent(instance.app);
  const login = await owner.post("/api/auth/login")
    .send({ username: "task-owner", password: "Owner-Taskboard-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  const createdProject = await owner.post("/api/taskboard/projects")
    .set("X-CSRF-Token", csrf)
    .send({ name: "Product", description: "MVP", executor: { kind: "tenant" } }).expect(201);
  const project = createdProject.body.project as { id: string; version: number };
  const createdTask = await owner.post(`/api/taskboard/projects/${project.id}/tasks`)
    .set("X-CSRF-Token", csrf)
    .send({ title: "Build board", priority: "high", risk: "low", acceptanceCriteria: "All tests pass" }).expect(201);
  let task = createdTask.body.task as { id: string; version: number; status: string };

  await owner.post(`/api/taskboard/tasks/${task.id}/transition`)
    .set("X-CSRF-Token", csrf).send({ version: task.version, status: "done" }).expect(400);
  let response = await owner.post(`/api/taskboard/tasks/${task.id}/transition`)
    .set("X-CSRF-Token", csrf).send({ version: task.version, status: "ready" }).expect(200);
  task = response.body.task;
  await owner.post(`/api/taskboard/tasks/${task.id}/transition`)
    .set("X-CSRF-Token", csrf).send({ version: task.version, status: "running" }).expect(409);
  response = await owner.post(`/api/taskboard/tasks/${task.id}/start`)
    .set("X-CSRF-Token", csrf).send({ version: task.version }).expect(202);
  task = response.body.task;
  assert.equal(task.status, "running");
  assert.equal(task.executionStatus, "queued");
  instance.db.finishJob(response.body.job.id, response.body.job.conversationId, "completed");
  instance.taskboardStore.settleTaskForJob(response.body.job.id);
  const afterExecution = await owner.get(`/api/taskboard/projects/${project.id}`).expect(200);
  task = afterExecution.body.tasks[0];
  assert.equal(task.status, "review");
  response = await owner.post(`/api/taskboard/tasks/${task.id}/transition`)
    .set("X-CSRF-Token", csrf).send({ version: task.version, status: "done" }).expect(200);
  task = response.body.task;
  assert.equal(task.status, "done");

  const detail = await owner.get(`/api/taskboard/projects/${project.id}`).expect(200);
  assert.equal(detail.body.tasks.length, 1);
  assert.equal(detail.body.tasks[0].status, "done");
  const events = await owner.get(`/api/taskboard/tasks/${task.id}/events`).expect(200);
  assert.ok(events.body.events.some((event: { event_type: string }) => event.event_type === "task.transitioned"));

  const archived = await owner.delete(`/api/taskboard/tasks/${task.id}`)
    .set("X-CSRF-Token", csrf).send({ version: task.version }).expect(200);
  assert.ok(archived.body.task.archivedAt);
  const afterArchive = await owner.get(`/api/taskboard/projects/${project.id}`).expect(200);
  assert.equal(afterArchive.body.tasks.length, 0);
});

test("remote taskboard projects require a currently advertised logical project id", async (t) => {
  const instance = setup(t);
  const owner = request.agent(instance.app);
  const login = await owner.post("/api/auth/login")
    .send({ username: "task-owner", password: "Owner-Taskboard-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  await owner.post("/api/taskboard/projects")
    .set("X-CSRF-Token", csrf)
    .send({ name: "Offline", executor: { kind: "remote", projectId: "offline-project" } }).expect(409);

  const advertised = advertiseRemoteProject(t, instance, "online-project", "remote:taskboard-worker");
  const created = await owner.post("/api/taskboard/projects")
    .set("X-CSRF-Token", csrf)
    .send({ name: "Online", executor: { kind: "remote", projectId: "online-project" } }).expect(201);
  assert.deepEqual(created.body.project.executor, { kind: "remote", projectId: "online-project" });

  const taskCreated = await owner.post(`/api/taskboard/projects/${created.body.project.id}/tasks`)
    .set("X-CSRF-Token", csrf)
    .send({ title: "Fail closed start", priority: "high", risk: "low" }).expect(201);
  const ready = await owner.post(`/api/taskboard/tasks/${taskCreated.body.task.id}/transition`)
    .set("X-CSRF-Token", csrf)
    .send({ version: taskCreated.body.task.version, status: "ready" }).expect(200);
  advertised.setOnline(false);
  await owner.post(`/api/taskboard/tasks/${taskCreated.body.task.id}/start`)
    .set("X-CSRF-Token", csrf)
    .send({ version: ready.body.task.version }).expect(409);
  const detail = await owner.get(`/api/taskboard/projects/${created.body.project.id}`).expect(200);
  assert.equal(detail.body.tasks[0].status, "ready");
  assert.equal(detail.body.tasks[0].conversationId, null);
  assert.equal(detail.body.tasks[0].executionStatus, null);
});

test("starting a board task queues the selected remote project and settles it to review", async (t) => {
  const instance = setup(t);
  const owner = request.agent(instance.app);
  const login = await owner.post("/api/auth/login")
    .send({ username: "task-owner", password: "Owner-Taskboard-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  advertiseRemoteProject(t, instance, "execution-project", "remote:execution-worker");

  const project = (await owner.post("/api/taskboard/projects")
    .set("X-CSRF-Token", csrf)
    .send({ name: "Execution", executor: { kind: "remote", projectId: "execution-project" } })
    .expect(201)).body.project;
  let task = (await owner.post(`/api/taskboard/projects/${project.id}/tasks`)
    .set("X-CSRF-Token", csrf)
    .send({ title: "Run remotely", description: "perform controlled work", acceptanceCriteria: "worker completes" })
    .expect(201)).body.task;
  task = (await owner.post(`/api/taskboard/tasks/${task.id}/transition`)
    .set("X-CSRF-Token", csrf).send({ version: task.version, status: "ready" }).expect(200)).body.task;
  const started = await owner.post(`/api/taskboard/tasks/${task.id}/start`)
    .set("X-CSRF-Token", csrf).send({ version: task.version }).expect(202);
  assert.equal(started.body.task.status, "running");
  assert.equal(instance.db.getConversation(started.body.job.conversationId)?.project_id, "execution-project");
  instance.db.finishJob(started.body.job.id, started.body.job.conversationId, "completed");
  instance.taskboardStore.settleTaskForJob(started.body.job.id);
  const detail = await owner.get(`/api/taskboard/projects/${project.id}`).expect(200);
  assert.equal(detail.body.tasks[0].status, "review");
  assert.equal(detail.body.tasks[0].executionStatus, "completed");
});
