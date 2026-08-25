import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import {
  TaskboardConflictError,
  TaskboardStore,
  TaskboardValidationError,
} from "../server/taskboard-store.js";

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-taskboard-store-"));
  const db = new AppDatabase(root, { username: "owner", passwordHash: "", displayName: "Owner" }, false);
  const store = new TaskboardStore(db);
  t.after(() => {
    db.sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, store };
}

function createTask(store: TaskboardStore, projectId: string, title: string) {
  return store.createTask(projectId, LEGACY_USER_ID, {
    title,
    description: "",
    priority: "medium",
    risk: "low",
    acceptanceCriteria: `${title} 已验证`,
  });
}

test("taskboard persists projects, hierarchy and immutable executor snapshots", (t) => {
  const { db, store } = setup(t);
  const project = store.createProject(LEGACY_USER_ID, {
    name: "Remote board",
    description: "A controlled project",
    executor: { kind: "remote", projectId: "safe-project" },
  });
  const parent = createTask(store, project.id, "Parent");
  const child = store.createTask(project.id, LEGACY_USER_ID, {
    title: "Child",
    description: "child work",
    parentTaskId: parent.id,
    priority: "high",
    risk: "medium",
    estimatePoints: 3,
    acceptanceCriteria: "tests pass",
  });

  assert.equal(store.listProjects(LEGACY_USER_ID).length, 1);
  assert.equal(store.listTasks(project.id, LEGACY_USER_ID).length, 2);
  assert.equal(child.parent_task_id, parent.id);
  assert.equal(child.executor_kind, "remote");
  assert.equal(child.remote_project_id, "safe-project");
  assert.equal(db.sqlite.prepare("SELECT count(1) AS count FROM taskboard_events").get()?.count, 3);
});

test("dependencies are same-project, acyclic and block work until completed", (t) => {
  const { db, store } = setup(t);
  const project = store.createProject(LEGACY_USER_ID, { name: "Board", description: "", executor: { kind: "tenant" } });
  const foundation = createTask(store, project.id, "Foundation");
  const feature = createTask(store, project.id, "Feature");

  const featureWithDependency = store.replaceDependencies(feature.id, LEGACY_USER_ID, feature.version, [foundation.id]);
  const featureReady = store.transitionTask(feature.id, LEGACY_USER_ID, featureWithDependency.version, "ready");
  assert.throws(
    () => store.startTask(feature.id, LEGACY_USER_ID, featureReady.version, { model: "gpt-test", reasoningEffort: "high" }),
    (error: unknown) => error instanceof TaskboardConflictError && /前置任务/.test(error.message),
  );

  let current = store.transitionTask(foundation.id, LEGACY_USER_ID, foundation.version, "ready");
  const foundationRun = store.startTask(foundation.id, LEGACY_USER_ID, current.version, { model: "gpt-test", reasoningEffort: "high" });
  db.finishJob(foundationRun.job.id, foundationRun.conversationId, "completed");
  current = store.settleTaskForJob(foundationRun.job.id)!;
  assert.equal(current.status, "review");
  current = store.transitionTask(foundation.id, LEGACY_USER_ID, current.version, "done");
  assert.equal(current.status, "done");

  const running = store.startTask(feature.id, LEGACY_USER_ID, featureReady.version, { model: "gpt-test", reasoningEffort: "high" });
  assert.equal(running.task.status, "running");
  assert.equal(running.job.status, "queued");
});

test("dependency and parent cycles are rejected", (t) => {
  const { store } = setup(t);
  const project = store.createProject(LEGACY_USER_ID, { name: "Cycles", description: "", executor: { kind: "tenant" } });
  const first = createTask(store, project.id, "First");
  const second = createTask(store, project.id, "Second");
  const firstUpdated = store.replaceDependencies(first.id, LEGACY_USER_ID, first.version, [second.id]);
  assert.equal(firstUpdated.version, first.version + 1);
  assert.throws(
    () => store.replaceDependencies(second.id, LEGACY_USER_ID, second.version, [first.id]),
    (error: unknown) => error instanceof TaskboardValidationError && /循环/.test(error.message),
  );

  const parented = store.updateTask(second.id, LEGACY_USER_ID, second.version, { parentTaskId: first.id });
  assert.equal(parented.parent_task_id, first.id);
  assert.throws(
    () => store.updateTask(first.id, LEGACY_USER_ID, firstUpdated.version, { parentTaskId: second.id }),
    (error: unknown) => error instanceof TaskboardValidationError && /循环/.test(error.message),
  );
});

test("optimistic versions and transition state machine prevent stale or unsafe completion", (t) => {
  const { store } = setup(t);
  const project = store.createProject(LEGACY_USER_ID, { name: "Versions", description: "", executor: { kind: "tenant" } });
  const task = createTask(store, project.id, "Versioned task");
  const updated = store.updateTask(task.id, LEGACY_USER_ID, task.version, { priority: "urgent" });
  assert.equal(updated.priority, "urgent");
  assert.throws(
    () => store.updateTask(task.id, LEGACY_USER_ID, task.version, { title: "stale" }),
    (error: unknown) => error instanceof TaskboardConflictError,
  );
  assert.throws(
    () => store.transitionTask(task.id, LEGACY_USER_ID, updated.version, "done"),
    (error: unknown) => error instanceof TaskboardValidationError,
  );
});

test("a task conversation must belong to the owner and match the project executor", (t) => {
  const { db, store } = setup(t);
  const conversation = db.createConversation("conversation-taskboard", LEGACY_USER_ID);
  const remote = store.createProject(LEGACY_USER_ID, {
    name: "Remote",
    description: "",
    executor: { kind: "remote", projectId: "remote-project" },
  });
  assert.throws(
    () => store.createTask(remote.id, LEGACY_USER_ID, {
      title: "Mismatch",
      description: "",
      priority: "medium",
      risk: "low",
      acceptanceCriteria: "",
      conversationId: conversation.id,
    }),
    (error: unknown) => error instanceof TaskboardValidationError && /执行位置/.test(error.message),
  );

  db.sqlite.prepare(`
    INSERT INTO conversation_executors(conversation_id,kind,project_id,updated_at) VALUES(?, 'remote', ?, ?)
  `).run(conversation.id, "remote-project", new Date().toISOString());
  const linked = store.createTask(remote.id, LEGACY_USER_ID, {
    title: "Matched",
    description: "",
    priority: "medium",
    risk: "low",
    acceptanceCriteria: "",
    conversationId: conversation.id,
  });
  assert.equal(linked.conversation_id, conversation.id);
});

test("only terminal unreferenced tasks can be archived", (t) => {
  const { store } = setup(t);
  const project = store.createProject(LEGACY_USER_ID, { name: "Archive", description: "", executor: { kind: "tenant" } });
  const task = createTask(store, project.id, "Archived task");
  assert.throws(
    () => store.archiveTask(task.id, LEGACY_USER_ID, task.version),
    (error: unknown) => error instanceof TaskboardConflictError && /已完成或已取消/.test(error.message),
  );
  let terminal = store.transitionTask(task.id, LEGACY_USER_ID, task.version, "cancelled");
  terminal = store.archiveTask(task.id, LEGACY_USER_ID, terminal.version);
  assert.ok(terminal.archived_at);
  assert.equal(store.listTasks(project.id, LEGACY_USER_ID).length, 0);
  assert.ok(store.listEvents(task.id, LEGACY_USER_ID).some((event) => event.event_type === "task.archived"));
});

test("projects with backlog tasks cannot be archived", (t) => {
  const { store } = setup(t);
  const project = store.createProject(LEGACY_USER_ID, { name: "Active", description: "", executor: { kind: "tenant" } });
  createTask(store, project.id, "Backlog task");
  const current = store.getProject(project.id, LEGACY_USER_ID)!;
  assert.throws(
    () => store.archiveProject(project.id, LEGACY_USER_ID, current.version),
    (error: unknown) => error instanceof TaskboardConflictError && /待处理任务/.test(error.message),
  );
});

test("running requires an atomic queued Codex job and terminal jobs reconcile the board", (t) => {
  const { db, store } = setup(t);
  const project = store.createProject(LEGACY_USER_ID, { name: "Execution", description: "", executor: { kind: "remote", projectId: "logical-project" } });
  const task = createTask(store, project.id, "Execute for real");
  const ready = store.transitionTask(task.id, LEGACY_USER_ID, task.version, "ready");
  assert.throws(
    () => store.transitionTask(task.id, LEGACY_USER_ID, ready.version, "running"),
    (error: unknown) => error instanceof TaskboardConflictError && /真实启动/.test(error.message),
  );

  const started = store.startTask(task.id, LEGACY_USER_ID, ready.version, { model: "gpt-test", reasoningEffort: "high" });
  assert.equal(started.task.status, "running");
  assert.equal(started.task.conversation_id, started.conversationId);
  assert.equal(store.getTaskExecution(task.id, LEGACY_USER_ID)?.status, "queued");
  const executor = db.sqlite.prepare("SELECT kind,project_id FROM conversation_executors WHERE conversation_id=?").get(started.conversationId) as { kind: string; project_id: string };
  assert.equal(executor.kind, "remote");
  assert.equal(executor.project_id, "logical-project");
  const message = db.getMessage(started.job.message_id!);
  assert.match(message?.content ?? "", /Execute for real/);
  assert.doesNotMatch(message?.content ?? "", /cwd|CODEX_HOME|REMOTE_WORKER_TOKEN/);

  db.finishJob(started.job.id, started.conversationId, "completed");
  const review = store.settleTaskForJob(started.job.id)!;
  assert.equal(review.status, "review");
});

test("failed Codex work becomes blocked instead of completed", (t) => {
  const { db, store } = setup(t);
  const project = store.createProject(LEGACY_USER_ID, { name: "Failure", description: "", executor: { kind: "tenant" } });
  const task = createTask(store, project.id, "Failure task");
  const ready = store.transitionTask(task.id, LEGACY_USER_ID, task.version, "ready");
  const started = store.startTask(task.id, LEGACY_USER_ID, ready.version, { model: "gpt-test", reasoningEffort: "high" });
  db.finishJob(started.job.id, started.conversationId, "failed", "controlled test failure");
  assert.equal(store.settleTaskForJob(started.job.id)?.status, "blocked");
});

test("a late result from an older job cannot settle a restarted task", (t) => {
  const { db, store } = setup(t);
  const project = store.createProject(LEGACY_USER_ID, { name: "Restart", description: "", executor: { kind: "tenant" } });
  const task = createTask(store, project.id, "Restart safely");
  let current = store.transitionTask(task.id, LEGACY_USER_ID, task.version, "ready");
  const first = store.startTask(task.id, LEGACY_USER_ID, current.version, { model: "gpt-test", reasoningEffort: "high" });
  db.finishJob(first.job.id, first.conversationId, "failed", "first attempt failed");
  current = store.settleTaskForJob(first.job.id)!;
  current = store.transitionTask(task.id, LEGACY_USER_ID, current.version, "ready");
  const second = store.startTask(task.id, LEGACY_USER_ID, current.version, { model: "gpt-test", reasoningEffort: "high" });

  assert.equal(store.settleTaskForJob(first.job.id), null);
  assert.equal(store.getTask(task.id, LEGACY_USER_ID)?.status, "running");
  assert.equal(store.getTask(task.id, LEGACY_USER_ID)?.active_job_id, second.job.id);
  db.finishJob(second.job.id, second.conversationId, "completed");
  assert.equal(store.settleTaskForJob(second.job.id)?.status, "review");
});
