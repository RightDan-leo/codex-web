import crypto from "node:crypto";
import type { AppDatabase, JobRow, StoredAgentSelection } from "./db.js";
import {
  canTransitionTask,
  type TaskboardPriority,
  type TaskboardRisk,
  type TaskboardStatus,
} from "./taskboard-policy.js";

export type TaskboardExecutorTarget =
  | { kind: "tenant" }
  | { kind: "remote"; projectId: string };

export type TaskboardProjectRow = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  executor_kind: "tenant" | "remote";
  remote_project_id: string | null;
  automation_mode: "manual" | "assist" | "auto_low_risk";
  max_concurrency: number;
  preferences: string;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskboardTaskRow = {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: TaskboardStatus;
  priority: TaskboardPriority;
  risk: TaskboardRisk;
  estimate_points: number | null;
  acceptance_criteria: string;
  position: number;
  conversation_id: string | null;
  active_job_id: string | null;
  executor_kind: "tenant" | "remote";
  remote_project_id: string | null;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskboardDependencyRow = {
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
};

export type TaskboardEventRow = {
  id: number;
  project_id: string;
  task_id: string | null;
  actor_user_id: string;
  event_type: string;
  payload: string;
  created_at: string;
};

export type TaskboardExecution = {
  jobId: string;
  status: JobRow["status"];
};

export type StartedTaskboardTask = {
  task: TaskboardTaskRow;
  job: JobRow;
  conversationId: string;
};

export class TaskboardValidationError extends Error {}
export class TaskboardConflictError extends Error {}
export class TaskboardNotFoundError extends Error {}

type CreateProjectInput = {
  name: string;
  description: string;
  executor: TaskboardExecutorTarget;
};

type UpdateProjectInput = {
  name?: string;
  description?: string;
  maxConcurrency?: number;
};

type CreateTaskInput = {
  title: string;
  description: string;
  parentTaskId?: string | null;
  priority: TaskboardPriority;
  risk: TaskboardRisk;
  estimatePoints?: number | null;
  acceptanceCriteria: string;
  conversationId?: string | null;
};

type UpdateTaskInput = {
  title?: string;
  description?: string;
  parentTaskId?: string | null;
  priority?: TaskboardPriority;
  risk?: TaskboardRisk;
  estimatePoints?: number | null;
  acceptanceCriteria?: string;
  conversationId?: string | null;
};

export class TaskboardStore {
  constructor(private readonly db: AppDatabase) {
    this.reconcileLegacyRunningTasks();
    this.reconcileTerminalExecutions();
  }

  listProjects(userId: string, includeArchived = false): TaskboardProjectRow[] {
    return this.db.sqlite.prepare(`
      SELECT * FROM taskboard_projects
      WHERE user_id=? ${includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY archived_at IS NOT NULL,updated_at DESC,id
    `).all(userId) as TaskboardProjectRow[];
  }

  getProject(id: string, userId: string, includeArchived = false): TaskboardProjectRow | undefined {
    return this.db.sqlite.prepare(`
      SELECT * FROM taskboard_projects WHERE id=? AND user_id=? ${includeArchived ? "" : "AND archived_at IS NULL"}
    `).get(id, userId) as TaskboardProjectRow | undefined;
  }

  createProject(userId: string, input: CreateProjectInput): TaskboardProjectRow {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.db.sqlite.prepare(`
        INSERT INTO taskboard_projects(
          id,user_id,name,description,executor_kind,remote_project_id,automation_mode,max_concurrency,
          preferences,version,archived_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,'manual',1,'{}',1,NULL,?,?)
      `).run(
        id, userId, input.name, input.description, input.executor.kind,
        input.executor.kind === "remote" ? input.executor.projectId : null, now, now,
      );
      this.appendEvent(id, null, userId, "project.created", { name: input.name, executor: input.executor }, now);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getProject(id, userId)!;
  }

  updateProject(id: string, userId: string, version: number, input: UpdateProjectInput): TaskboardProjectRow {
    const project = this.requireProject(id, userId);
    if (project.version !== version) throw new TaskboardConflictError("项目已被其他操作更新，请刷新后重试。");
    const next = {
      name: input.name ?? project.name,
      description: input.description ?? project.description,
      maxConcurrency: input.maxConcurrency ?? project.max_concurrency,
    };
    const now = new Date().toISOString();
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.sqlite.prepare(`
        UPDATE taskboard_projects SET name=?,description=?,max_concurrency=?,version=version+1,updated_at=?
        WHERE id=? AND user_id=? AND version=? AND archived_at IS NULL
      `).run(next.name, next.description, next.maxConcurrency, now, id, userId, version);
      if (result.changes !== 1) throw new TaskboardConflictError("项目已被其他操作更新，请刷新后重试。");
      this.appendEvent(id, null, userId, "project.updated", input, now);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.requireProject(id, userId);
  }

  archiveProject(id: string, userId: string, version: number): TaskboardProjectRow {
    const project = this.requireProject(id, userId);
    if (project.version !== version) throw new TaskboardConflictError("项目已被其他操作更新，请刷新后重试。");
    const active = this.db.sqlite.prepare(`
      SELECT count(1) AS count FROM taskboard_tasks
      WHERE project_id=? AND archived_at IS NULL AND status NOT IN ('done','cancelled')
    `).get(id) as { count: number };
    if (active.count > 0) throw new TaskboardConflictError("项目仍有待处理任务，完成或取消后才能归档。");
    const now = new Date().toISOString();
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.sqlite.prepare(`
        UPDATE taskboard_projects SET archived_at=?,version=version+1,updated_at=?
        WHERE id=? AND user_id=? AND version=? AND archived_at IS NULL
      `).run(now, now, id, userId, version);
      if (result.changes !== 1) throw new TaskboardConflictError("项目已被其他操作更新，请刷新后重试。");
      this.appendEvent(id, null, userId, "project.archived", {}, now);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getProject(id, userId, true)!;
  }

  listTasks(projectId: string, userId: string, includeArchived = false): TaskboardTaskRow[] {
    this.requireProject(projectId, userId, includeArchived);
    return this.db.sqlite.prepare(`
      SELECT task.* FROM taskboard_tasks task
      WHERE task.project_id=? ${includeArchived ? "" : "AND task.archived_at IS NULL"}
      ORDER BY CASE task.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        task.position,task.created_at,task.id
    `).all(projectId) as TaskboardTaskRow[];
  }

  getTask(id: string, userId: string, includeArchived = false): TaskboardTaskRow | undefined {
    return this.db.sqlite.prepare(`
      SELECT task.* FROM taskboard_tasks task
      JOIN taskboard_projects project ON project.id=task.project_id
      WHERE task.id=? AND project.user_id=? ${includeArchived ? "" : "AND task.archived_at IS NULL AND project.archived_at IS NULL"}
    `).get(id, userId) as TaskboardTaskRow | undefined;
  }

  getTaskExecution(id: string, userId: string): TaskboardExecution | null {
    const task = this.requireTask(id, userId, true);
    if (!task.conversation_id) return null;
    const job = this.db.sqlite.prepare(`
      SELECT id,status FROM jobs WHERE conversation_id=?
      ORDER BY id=? DESC,created_at DESC,id DESC LIMIT 1
    `).get(task.conversation_id, task.active_job_id ?? "") as { id: string; status: JobRow["status"] } | undefined;
    return job ? { jobId: job.id, status: job.status } : null;
  }

  createTask(projectId: string, userId: string, input: CreateTaskInput): TaskboardTaskRow {
    const project = this.requireProject(projectId, userId);
    if (input.parentTaskId) this.requireTaskInProject(input.parentTaskId, projectId, userId);
    if (input.conversationId) this.validateConversation(project, input.conversationId, userId);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const nextPosition = this.nextPosition(projectId, "backlog");
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.db.sqlite.prepare(`
        INSERT INTO taskboard_tasks(
          id,project_id,parent_task_id,title,description,status,priority,risk,estimate_points,acceptance_criteria,
          position,conversation_id,active_job_id,executor_kind,remote_project_id,version,archived_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,'backlog',?,?,?,?,?,?,NULL,?, ?,1,NULL,?,?)
      `).run(
        id, projectId, input.parentTaskId ?? null, input.title, input.description, input.priority, input.risk,
        input.estimatePoints ?? null, input.acceptanceCriteria, nextPosition, input.conversationId ?? null,
        project.executor_kind, project.remote_project_id, now, now,
      );
      this.appendEvent(projectId, id, userId, "task.created", {
        title: input.title, priority: input.priority, risk: input.risk,
      }, now);
      this.db.sqlite.prepare("UPDATE taskboard_projects SET version=version+1,updated_at=? WHERE id=?").run(now, projectId);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      if (String(error).includes("UNIQUE constraint failed: taskboard_tasks.conversation_id")) {
        throw new TaskboardConflictError("这个会话已经关联到另一张任务卡。");
      }
      throw error;
    }
    return this.getTask(id, userId)!;
  }

  updateTask(id: string, userId: string, version: number, input: UpdateTaskInput): TaskboardTaskRow {
    const task = this.requireTask(id, userId);
    if (task.version !== version) throw new TaskboardConflictError("任务已被其他操作更新，请刷新后重试。");
    const project = this.requireProject(task.project_id, userId);
    if (input.parentTaskId !== undefined && input.parentTaskId !== task.parent_task_id) {
      if (["running", "review", "done", "cancelled"].includes(task.status)) {
        throw new TaskboardConflictError("任务进入实际工作后不能修改父任务。");
      }
      if (input.parentTaskId) {
        this.requireTaskInProject(input.parentTaskId, task.project_id, userId);
        this.assertParentDoesNotCycle(task.id, input.parentTaskId, task.project_id);
      }
    }
    if (input.conversationId !== undefined && input.conversationId !== task.conversation_id) {
      if (!["backlog", "ready"].includes(task.status) || task.conversation_id) {
        throw new TaskboardConflictError("任务开始或关联会话后不能更换会话。");
      }
      if (input.conversationId) this.validateConversation(project, input.conversationId, userId);
    }
    const now = new Date().toISOString();
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.sqlite.prepare(`
        UPDATE taskboard_tasks SET
          parent_task_id=?,title=?,description=?,priority=?,risk=?,estimate_points=?,acceptance_criteria=?,conversation_id=?,
          version=version+1,updated_at=?
        WHERE id=? AND version=? AND archived_at IS NULL
      `).run(
        input.parentTaskId !== undefined ? input.parentTaskId : task.parent_task_id,
        input.title ?? task.title,
        input.description ?? task.description,
        input.priority ?? task.priority,
        input.risk ?? task.risk,
        input.estimatePoints !== undefined ? input.estimatePoints : task.estimate_points,
        input.acceptanceCriteria ?? task.acceptance_criteria,
        input.conversationId !== undefined ? input.conversationId : task.conversation_id,
        now, id, version,
      );
      if (result.changes !== 1) throw new TaskboardConflictError("任务已被其他操作更新，请刷新后重试。");
      this.appendEvent(task.project_id, id, userId, "task.updated", input, now);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.requireTask(id, userId);
  }

  archiveTask(id: string, userId: string, version: number): TaskboardTaskRow {
    const task = this.requireTask(id, userId);
    if (task.version !== version) throw new TaskboardConflictError("任务已被其他操作更新，请刷新后重试。");
    if (!["done", "cancelled"].includes(task.status)) {
      throw new TaskboardConflictError("只有已完成或已取消的任务才能归档。");
    }
    const referenced = this.db.sqlite.prepare(`
      SELECT dependent.title FROM taskboard_task_dependencies relation
      JOIN taskboard_tasks dependent ON dependent.id=relation.task_id
      WHERE relation.depends_on_task_id=? AND dependent.archived_at IS NULL LIMIT 1
    `).get(id) as { title: string } | undefined;
    if (referenced) throw new TaskboardConflictError(`仍有任务依赖此任务：${referenced.title}`);
    const child = this.db.sqlite.prepare(`
      SELECT title FROM taskboard_tasks WHERE parent_task_id=? AND archived_at IS NULL LIMIT 1
    `).get(id) as { title: string } | undefined;
    if (child) throw new TaskboardConflictError(`仍有未归档子任务：${child.title}`);
    const now = new Date().toISOString();
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.sqlite.prepare(`
        UPDATE taskboard_tasks SET archived_at=?,version=version+1,updated_at=?
        WHERE id=? AND version=? AND archived_at IS NULL
      `).run(now, now, id, version);
      if (result.changes !== 1) throw new TaskboardConflictError("任务已被其他操作更新，请刷新后重试。");
      this.appendEvent(task.project_id, id, userId, "task.archived", {}, now);
      this.db.sqlite.prepare("UPDATE taskboard_projects SET version=version+1,updated_at=? WHERE id=?").run(now, task.project_id);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(id, userId, true)!;
  }

  startTask(id: string, userId: string, version: number, selection: StoredAgentSelection): StartedTaskboardTask {
    const task = this.requireTask(id, userId);
    if (task.version !== version) throw new TaskboardConflictError("任务已被其他操作更新，请刷新后重试。");
    const recoveringFalseRunning = task.status === "running" && !task.conversation_id;
    if (task.status !== "ready" && !recoveringFalseRunning) {
      throw new TaskboardConflictError("只有待开发任务可以启动；正在运行的任务不会重复执行。");
    }
    const blocked = this.db.sqlite.prepare(`
      SELECT dependency.title FROM taskboard_task_dependencies relation
      JOIN taskboard_tasks dependency ON dependency.id=relation.depends_on_task_id
      WHERE relation.task_id=? AND dependency.status<>'done' LIMIT 1
    `).get(id) as { title: string } | undefined;
    if (blocked) throw new TaskboardConflictError(`前置任务尚未完成：${blocked.title}`);

    const project = this.requireProject(task.project_id, userId);
    const activeInProject = this.db.sqlite.prepare(`
      SELECT count(1) AS count FROM taskboard_tasks queued
      JOIN jobs job ON job.id=queued.active_job_id
      WHERE queued.project_id=? AND queued.id<>? AND queued.status='running'
        AND queued.archived_at IS NULL AND job.status IN ('queued','running')
    `).get(task.project_id, task.id) as { count: number };
    if (activeInProject.count >= project.max_concurrency) {
      throw new TaskboardConflictError(`项目并发上限为 ${project.max_concurrency}，请等待正在执行的任务完成。`);
    }
    const conversationId = task.conversation_id ?? crypto.randomUUID();
    if (task.conversation_id) {
      this.validateConversation(project, conversationId, userId);
      const active = this.db.sqlite.prepare(`
        SELECT 1 AS found FROM jobs WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1
      `).get(conversationId) as { found: number } | undefined;
      if (active) throw new TaskboardConflictError("任务已经排队或正在执行，不会重复启动。");
    }
    const messageId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const position = this.nextPosition(task.project_id, "running");
    const prompt = buildTaskboardPrompt(task);
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (!task.conversation_id) {
        this.db.sqlite.prepare(`
          INSERT INTO conversations(
            id,user_id,title,title_source,agent_model,reasoning_effort,status,has_unread_result,
            archived_at,deleted_at,created_at,updated_at
          ) VALUES(?,?,?,'manual',?,?,'idle',0,NULL,NULL,?,?)
        `).run(conversationId, userId, task.title, selection.model, selection.reasoningEffort, now, now);
        if (task.executor_kind === "remote") {
          this.db.sqlite.prepare(`
            INSERT INTO conversation_executors(conversation_id,kind,project_id,updated_at)
            VALUES(?,'remote',?,?)
          `).run(conversationId, task.remote_project_id, now);
        }
      }
      this.db.sqlite.prepare(`
        INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at)
        VALUES(?,?,'user',?,NULL,?)
      `).run(messageId, conversationId, prompt, now);
      const nextQueue = this.db.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
      this.db.sqlite.prepare(`
        INSERT INTO jobs(
          id,conversation_id,message_id,agent_model,reasoning_effort,queue_seq,status,error,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,'queued',NULL,?,?)
      `).run(jobId, conversationId, messageId, selection.model, selection.reasoningEffort, nextQueue.value, now, now);
      this.db.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
      const updated = this.db.sqlite.prepare(`
        UPDATE taskboard_tasks SET conversation_id=?,active_job_id=?,status='running',position=?,version=version+1,updated_at=?
        WHERE id=? AND version=? AND archived_at IS NULL
      `).run(conversationId, jobId, position, now, id, version);
      if (updated.changes !== 1) throw new TaskboardConflictError("任务已被其他操作更新，请刷新后重试。");
      this.appendEvent(task.project_id, id, userId, "task.started", { conversationId, jobId }, now);
      this.db.sqlite.prepare("UPDATE taskboard_projects SET version=version+1,updated_at=? WHERE id=?").run(now, task.project_id);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return { task: this.requireTask(id, userId), job: this.db.getJob(jobId)!, conversationId };
  }

  settleTaskForJob(jobId: string): TaskboardTaskRow | null {
    const job = this.db.getJob(jobId);
    if (!job || !["completed", "failed", "cancelled", "interrupted"].includes(job.status)) return null;
    const task = this.db.sqlite.prepare(`
      SELECT task.*,project.user_id AS owner_user_id FROM taskboard_tasks task
      JOIN taskboard_projects project ON project.id=task.project_id
      WHERE task.active_job_id=? AND task.conversation_id=? AND task.status='running'
        AND task.archived_at IS NULL AND project.archived_at IS NULL
      LIMIT 1
    `).get(jobId, job.conversation_id) as (TaskboardTaskRow & { owner_user_id: string }) | undefined;
    if (!task) return null;
    const status: TaskboardStatus = job.status === "completed" ? "review" : "blocked";
    const now = new Date().toISOString();
    const position = this.nextPosition(task.project_id, status);
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db.sqlite.prepare(`
        UPDATE taskboard_tasks SET status=?,active_job_id=NULL,position=?,version=version+1,updated_at=?
        WHERE id=? AND version=? AND status='running' AND active_job_id=? AND archived_at IS NULL
      `).run(status, position, now, task.id, task.version, jobId);
      if (updated.changes !== 1) {
        this.db.sqlite.exec("ROLLBACK");
        return null;
      }
      this.appendEvent(task.project_id, task.id, task.owner_user_id, "task.execution_settled", {
        jobId, jobStatus: job.status, taskStatus: status,
      }, now);
      this.db.sqlite.prepare("UPDATE taskboard_projects SET version=version+1,updated_at=? WHERE id=?").run(now, task.project_id);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      try { this.db.sqlite.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return this.db.sqlite.prepare("SELECT * FROM taskboard_tasks WHERE id=?").get(task.id) as TaskboardTaskRow;
  }

  transitionTask(id: string, userId: string, version: number, to: TaskboardStatus, reason = ""): TaskboardTaskRow {
    const task = this.requireTask(id, userId);
    if (task.version !== version) throw new TaskboardConflictError("任务已被其他操作更新，请刷新后重试。");
    if (!canTransitionTask(task.status, to)) {
      throw new TaskboardValidationError(`不允许从 ${task.status} 切换到 ${to}。`);
    }
    if (to === "running") {
      throw new TaskboardConflictError("进入开发中必须真实启动 Codex，请使用启动任务操作。");
    }
    if (task.status === "running" && task.active_job_id) {
      const job = this.db.getJob(task.active_job_id);
      if (job && ["queued", "running"].includes(job.status)) {
        throw new TaskboardConflictError("Codex 仍在执行；请先停止工作会话，系统会把任务转为已阻塞。");
      }
    }
    const now = new Date().toISOString();
    const position = this.nextPosition(task.project_id, to);
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.sqlite.prepare(`
        UPDATE taskboard_tasks SET status=?,position=?,version=version+1,updated_at=?
        WHERE id=? AND version=? AND archived_at IS NULL
      `).run(to, position, now, id, version);
      if (result.changes !== 1) throw new TaskboardConflictError("任务已被其他操作更新，请刷新后重试。");
      this.appendEvent(task.project_id, id, userId, "task.transitioned", { from: task.status, to, reason }, now);
      this.db.sqlite.prepare("UPDATE taskboard_projects SET version=version+1,updated_at=? WHERE id=?").run(now, task.project_id);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.requireTask(id, userId);
  }

  replaceDependencies(id: string, userId: string, version: number, dependencyIds: string[]): TaskboardTaskRow {
    const task = this.requireTask(id, userId);
    if (task.version !== version) throw new TaskboardConflictError("任务已被其他操作更新，请刷新后重试。");
    if (["running", "review", "done", "cancelled"].includes(task.status)) {
      throw new TaskboardConflictError("任务进入实际工作后不能修改依赖。");
    }
    const uniqueIds = [...new Set(dependencyIds)];
    if (uniqueIds.includes(id)) throw new TaskboardValidationError("任务不能依赖自己。");
    for (const dependencyId of uniqueIds) this.requireTaskInProject(dependencyId, task.project_id, userId);
    this.assertDependenciesDoNotCycle(task.id, task.project_id, uniqueIds);
    const now = new Date().toISOString();
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.db.sqlite.prepare("DELETE FROM taskboard_task_dependencies WHERE task_id=?").run(id);
      const insert = this.db.sqlite.prepare(`
        INSERT INTO taskboard_task_dependencies(task_id,depends_on_task_id,created_at) VALUES(?,?,?)
      `);
      for (const dependencyId of uniqueIds) insert.run(id, dependencyId, now);
      const result = this.db.sqlite.prepare(`
        UPDATE taskboard_tasks SET version=version+1,updated_at=? WHERE id=? AND version=? AND archived_at IS NULL
      `).run(now, id, version);
      if (result.changes !== 1) throw new TaskboardConflictError("任务已被其他操作更新，请刷新后重试。");
      this.appendEvent(task.project_id, id, userId, "task.dependencies_updated", { dependencyIds: uniqueIds }, now);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.requireTask(id, userId);
  }

  listDependencies(projectId: string, userId: string): TaskboardDependencyRow[] {
    this.requireProject(projectId, userId);
    return this.db.sqlite.prepare(`
      SELECT relation.* FROM taskboard_task_dependencies relation
      JOIN taskboard_tasks task ON task.id=relation.task_id
      WHERE task.project_id=? ORDER BY relation.task_id,relation.depends_on_task_id
    `).all(projectId) as TaskboardDependencyRow[];
  }

  listEvents(taskId: string, userId: string): TaskboardEventRow[] {
    this.requireTask(taskId, userId, true);
    return this.db.sqlite.prepare(`
      SELECT * FROM taskboard_events WHERE task_id=? ORDER BY id DESC LIMIT 200
    `).all(taskId) as TaskboardEventRow[];
  }

  private requireProject(id: string, userId: string, includeArchived = false): TaskboardProjectRow {
    const project = this.getProject(id, userId, includeArchived);
    if (!project) throw new TaskboardNotFoundError("项目不存在。");
    return project;
  }

  private requireTask(id: string, userId: string, includeArchived = false): TaskboardTaskRow {
    const task = this.getTask(id, userId, includeArchived);
    if (!task) throw new TaskboardNotFoundError("任务不存在。");
    return task;
  }

  private requireTaskInProject(id: string, projectId: string, userId: string): TaskboardTaskRow {
    const task = this.requireTask(id, userId);
    if (task.project_id !== projectId) throw new TaskboardValidationError("依赖和父任务必须属于同一个项目。");
    return task;
  }

  private nextPosition(projectId: string, status: TaskboardStatus): number {
    const row = this.db.sqlite.prepare(`
      SELECT COALESCE(MAX(position),0)+1 AS value FROM taskboard_tasks WHERE project_id=? AND status=? AND archived_at IS NULL
    `).get(projectId, status) as { value: number };
    return row.value;
  }

  private validateConversation(project: TaskboardProjectRow, conversationId: string, userId: string): void {
    const conversation = this.db.getConversationForUser(conversationId, userId);
    if (!conversation) throw new TaskboardValidationError("关联会话不存在。");
    const row = this.db.sqlite.prepare(`
      SELECT kind,project_id FROM conversation_executors WHERE conversation_id=?
    `).get(conversationId) as { kind: "tenant" | "remote"; project_id: string | null } | undefined;
    const executor = row ?? { kind: "tenant" as const, project_id: null };
    if (executor.kind !== project.executor_kind || executor.project_id !== project.remote_project_id) {
      throw new TaskboardValidationError("会话执行位置与看板项目不一致。");
    }
  }

  private assertParentDoesNotCycle(taskId: string, parentTaskId: string, projectId: string): void {
    let current: string | null = parentTaskId;
    const seen = new Set<string>();
    while (current) {
      if (current === taskId) throw new TaskboardValidationError("父子任务关系不能形成循环。");
      if (seen.has(current)) throw new TaskboardValidationError("现有父子任务关系包含循环。");
      seen.add(current);
      const row = this.db.sqlite.prepare(`
        SELECT parent_task_id FROM taskboard_tasks WHERE id=? AND project_id=?
      `).get(current, projectId) as { parent_task_id: string | null } | undefined;
      current = row?.parent_task_id ?? null;
    }
  }

  private assertDependenciesDoNotCycle(taskId: string, projectId: string, replacement: string[]): void {
    const rows = this.db.sqlite.prepare(`
      SELECT relation.task_id,relation.depends_on_task_id FROM taskboard_task_dependencies relation
      JOIN taskboard_tasks task ON task.id=relation.task_id WHERE task.project_id=?
    `).all(projectId) as TaskboardDependencyRow[];
    const graph = new Map<string, string[]>();
    for (const row of rows) {
      if (row.task_id === taskId) continue;
      graph.set(row.task_id, [...(graph.get(row.task_id) ?? []), row.depends_on_task_id]);
    }
    graph.set(taskId, replacement);
    const reachesTask = (id: string, visiting: Set<string>): boolean => {
      if (id === taskId) return true;
      if (visiting.has(id)) return false;
      visiting.add(id);
      return (graph.get(id) ?? []).some((next) => reachesTask(next, visiting));
    };
    for (const dependencyId of replacement) {
      if (reachesTask(dependencyId, new Set())) throw new TaskboardValidationError("任务依赖不能形成循环。");
    }
  }

  private appendEvent(
    projectId: string,
    taskId: string | null,
    actorUserId: string,
    eventType: string,
    payload: unknown,
    createdAt: string,
  ): void {
    this.db.sqlite.prepare(`
      INSERT INTO taskboard_events(project_id,task_id,actor_user_id,event_type,payload,created_at)
      VALUES(?,?,?,?,?,?)
    `).run(projectId, taskId, actorUserId, eventType, JSON.stringify(payload), createdAt);
  }

  private reconcileTerminalExecutions(): void {
    const jobs = this.db.sqlite.prepare(`
      SELECT job.id FROM jobs job
      JOIN taskboard_tasks task ON task.active_job_id=job.id
      WHERE task.status='running' AND job.status IN ('completed','failed','cancelled','interrupted')
    `).all() as Array<{ id: string }>;
    for (const job of jobs) this.settleTaskForJob(job.id);
  }

  private reconcileLegacyRunningTasks(): void {
    const tasks = this.db.sqlite.prepare(`
      SELECT task.*,project.user_id AS owner_user_id FROM taskboard_tasks task
      JOIN taskboard_projects project ON project.id=task.project_id
      WHERE task.status='running' AND task.active_job_id IS NULL AND task.archived_at IS NULL
    `).all() as Array<TaskboardTaskRow & { owner_user_id: string }>;
    for (const task of tasks) {
      const job = task.conversation_id ? this.db.sqlite.prepare(`
        SELECT id,status FROM jobs WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1
      `).get(task.conversation_id) as { id: string; status: JobRow["status"] } | undefined : undefined;
      const status: TaskboardStatus = job?.status === "completed"
        ? "review"
        : job && ["failed", "cancelled", "interrupted"].includes(job.status)
          ? "blocked"
          : job && ["queued", "running"].includes(job.status)
            ? "running"
            : "ready";
      const activeJobId = job && ["queued", "running"].includes(job.status) ? job.id : null;
      const now = new Date().toISOString();
      const position = this.nextPosition(task.project_id, status);
      this.db.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const updated = this.db.sqlite.prepare(`
          UPDATE taskboard_tasks SET status=?,active_job_id=?,position=?,version=version+1,updated_at=?
          WHERE id=? AND version=? AND status='running' AND active_job_id IS NULL
        `).run(status, activeJobId, position, now, task.id, task.version);
        if (updated.changes === 1) {
          this.appendEvent(task.project_id, task.id, task.owner_user_id, "task.legacy_execution_reconciled", {
            jobId: job?.id ?? null, jobStatus: job?.status ?? null, taskStatus: status,
          }, now);
          this.db.sqlite.prepare("UPDATE taskboard_projects SET version=version+1,updated_at=? WHERE id=?").run(now, task.project_id);
        }
        this.db.sqlite.exec("COMMIT");
      } catch (error) {
        this.db.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

export function buildTaskboardPrompt(task: TaskboardTaskRow): string {
  return [
    "请执行以下智能项目看板任务。",
    `任务：${task.title}`,
    task.description ? `说明：${task.description}` : "",
    task.acceptance_criteria ? `验收标准：${task.acceptance_criteria}` : "",
    "要求：",
    "- 只在当前执行器已经配置的项目范围内工作。",
    "- 先检查现有代码和约束，再实施修改并运行相关测试。",
    "- 完成后说明修改、验证结果和仍存在的限制。",
    "- 不要自行把任务标记为验收通过；最终验收由 Owner 完成。",
  ].filter(Boolean).join("\n");
}
