import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { TaskboardAgentTools } from "../server/taskboard-agent-tools.js";
import { TaskboardStore } from "../server/taskboard-store.js";

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-taskboard-agent-"));
  const db = new AppDatabase(root, { username: "owner", passwordHash: "", displayName: "Owner" }, false);
  const store = new TaskboardStore(db);
  const tools = new TaskboardAgentTools(db, store);
  t.after(() => {
    db.sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, store, tools };
}

function call(tools: TaskboardAgentTools, tool: string, args: unknown, executor: { kind: "tenant" } | { kind: "remote"; projectId: string } = { kind: "tenant" }) {
  return tools.execute({
    callId: crypto.randomUUID(),
    threadId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    namespace: "taskboard",
    tool,
    arguments: args,
  }, { userId: LEGACY_USER_ID, executor });
}

function value<T>(result: ReturnType<typeof call>): T {
  assert.equal(result.success, true, result.success ? undefined : result.error);
  return (result as { success: true; value: T }).value;
}

test("Owner agent can create and edit a scoped taskboard without bypassing acceptance", (t) => {
  const { store, tools } = setup(t);
  assert.equal(tools.specsForUser(LEGACY_USER_ID)?.[0]?.type, "namespace");

  const created = value<{ project: { id: string; executor_kind: string; remote_project_id: string | null } }>(
    call(tools, "create_project", { name: "Voice input", description: "Plan the work" }, { kind: "remote", projectId: "current-project" }),
  );
  assert.equal(created.project.executor_kind, "remote");
  assert.equal(created.project.remote_project_id, "current-project");

  const batch = value<{ tasks: Array<{ id: string; version: number; status: string }> }>(call(tools, "create_tasks", {
    projectId: created.project.id,
    tasks: [
      { title: "Foundation", priority: "urgent", risk: "low", acceptanceCriteria: "Tests pass" },
      { title: "Feature", description: "Add UI", estimatePoints: 3 },
    ],
  }));
  assert.equal(batch.tasks.length, 2);
  assert.ok(batch.tasks.every((task) => task.status === "backlog"));

  const dependency = value<{ task: { version: number } }>(call(tools, "set_dependencies", {
    taskId: batch.tasks[1]!.id,
    version: batch.tasks[1]!.version,
    dependencyIds: [batch.tasks[0]!.id],
  }));
  const ready = value<{ task: { version: number; status: string } }>(call(tools, "transition_task", {
    taskId: batch.tasks[1]!.id,
    version: dependency.task.version,
    status: "ready",
  }));
  assert.equal(ready.task.status, "ready");

  const denied = call(tools, "transition_task", {
    taskId: batch.tasks[1]!.id,
    version: ready.task.version,
    status: "done",
  });
  assert.equal(denied.success, false);
  assert.match((denied as { success: false; error: string }).error, /Owner|只能切换/);
  assert.equal(store.getTask(batch.tasks[1]!.id, LEGACY_USER_ID)?.status, "ready");
});

test("member agents do not receive or execute taskboard tools", (t) => {
  const { db, tools } = setup(t);
  const memberId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.createUser({
    id: memberId,
    username: "member",
    display_name: "Member",
    password_hash: "",
    role: "member",
    status: "active",
    created_at: now,
    updated_at: now,
  });
  assert.equal(tools.specsForUser(memberId), undefined);
  const result = tools.execute({
    callId: crypto.randomUUID(), threadId: crypto.randomUUID(), turnId: crypto.randomUUID(),
    namespace: "taskboard", tool: "list_projects", arguments: {},
  }, { userId: memberId, executor: { kind: "tenant" } });
  assert.equal(result.success, false);
  assert.match((result as { success: false; error: string }).error, /Owner/);
});
