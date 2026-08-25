import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { TaskboardTask } from "../src/api.js";
import { executorOnline, taskDraft, transitionLabel } from "../src/taskboard.js";

const task: TaskboardTask = {
  id: "task-ui",
  projectId: "board-ui",
  parentTaskId: null,
  title: "实现验收流程",
  description: "完成待验收门禁",
  status: "review",
  priority: "high",
  risk: "low",
  estimatePoints: 3,
  acceptanceCriteria: "只有用户可以验收",
  position: 1,
  conversationId: null,
  executor: { kind: "remote", projectId: "registered-project" },
  version: 1,
  archivedAt: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  allowedTransitions: ["ready", "done", "cancelled"],
};

test("taskboard UI reports remote availability only for the exact advertised logical project", () => {
  const workers = [{
    workerId: "worker-ui",
    displayName: "Worker UI",
    connectedAt: Date.now(),
    projects: [{ id: "registered-project", name: "Registered" }],
  }];
  assert.equal(executorOnline({ kind: "tenant" }, []), true);
  assert.equal(executorOnline(task.executor, workers), true);
  assert.equal(executorOnline({ kind: "remote", projectId: "other-project" }, workers), false);
});

test("task draft preserves acceptance authority and transition copy is explicit", () => {
  const draft = taskDraft(task);
  assert.match(draft, /实现验收流程/);
  assert.match(draft, /只有用户可以验收/);
  assert.match(draft, /不要自行把任务标记为验收通过/);
  assert.doesNotMatch(draft, /cwd|CODEX_HOME|REMOTE_WORKER_TOKEN/);
  assert.equal(transitionLabel("review", "done"), "验收通过");
  assert.equal(transitionLabel("review", "ready"), "驳回重做");
});

test("taskboard is rendered inside the main React app and hides the chat composer", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "taskboard.css"), "utf8");
  assert.match(appSource, /workspaceView === "taskboard" \? <TaskboardPage/);
  assert.match(appSource, /workspaceView === "chat" && \(!selectedId/);
  assert.match(appSource, /className={`taskboard-sidebar-button/);
  assert.match(styles, /\.taskboard-columns \{[^}]*overflow-x: auto;/);
  assert.match(styles, /@media \(max-width: 720px\)/);
});
