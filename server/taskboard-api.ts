import type { Router, Response } from "express";
import type { SessionRow } from "./db.js";
import type { StoredAgentSelection } from "./db.js";
import type { RemoteWorkerGateway } from "./remote-worker-gateway.js";
import {
  TaskboardConflictError,
  TaskboardNotFoundError,
  TaskboardStore,
  TaskboardValidationError,
  type TaskboardExecutorTarget,
  type TaskboardTaskRow,
} from "./taskboard-store.js";
import {
  isTaskboardPriority,
  isTaskboardRisk,
  isTaskboardStatus,
  transitionTargets,
} from "./taskboard-policy.js";

const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function installTaskboardApiRoutes(
  api: Router,
  store: TaskboardStore,
  gateway: RemoteWorkerGateway,
  options: {
    selectionForTask: (task: TaskboardTaskRow, userId: string) => StoredAgentSelection;
    onJobQueued: () => void;
  },
): void {
  api.get("/taskboard/projects", (_req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    return res.json({ projects: store.listProjects(session.user_id).map(serializeProject) });
  });

  api.post("/taskboard/projects", (req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    try {
      const executor = readExecutor(req.body?.executor);
      if (executor.kind === "remote" && !gateway.hasProject(executor.projectId)) {
        return res.status(409).json({ error: "所选远端项目当前不在线。请启动对应 Remote Worker 后再创建项目。" });
      }
      const project = store.createProject(session.user_id, {
        name: readRequiredText(req.body?.name, "项目名称", 120),
        description: readOptionalText(req.body?.description, "项目说明", 20_000),
        executor,
      });
      return res.status(201).json({ project: serializeProject(project) });
    } catch (error) {
      return sendTaskboardError(res, error);
    }
  });

  api.get("/taskboard/projects/:id", (req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    try {
      const project = store.getProject(String(req.params.id), session.user_id);
      if (!project) throw new TaskboardNotFoundError("项目不存在。");
      const tasks = store.listTasks(project.id, session.user_id);
      const dependencies = store.listDependencies(project.id, session.user_id);
      return res.json({
        project: serializeProject(project),
        tasks: tasks.map((task) => serializeTaskWithState(store, task, session.user_id)),
        dependencies,
      });
    } catch (error) {
      return sendTaskboardError(res, error);
    }
  });

  api.patch("/taskboard/projects/:id", (req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    try {
      const input: { name?: string; description?: string; maxConcurrency?: number } = {};
      if (Object.hasOwn(req.body ?? {}, "name")) input.name = readRequiredText(req.body.name, "项目名称", 120);
      if (Object.hasOwn(req.body ?? {}, "description")) input.description = readOptionalText(req.body.description, "项目说明", 20_000);
      if (Object.hasOwn(req.body ?? {}, "maxConcurrency")) input.maxConcurrency = readInteger(req.body.maxConcurrency, "并发上限", 1, 8);
      if (Object.keys(input).length === 0) throw new TaskboardValidationError("没有可更新的项目字段。");
      const project = store.updateProject(String(req.params.id), session.user_id, readVersion(req.body?.version), input);
      return res.json({ project: serializeProject(project) });
    } catch (error) {
      return sendTaskboardError(res, error);
    }
  });

  api.delete("/taskboard/projects/:id", (req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    try {
      const project = store.archiveProject(String(req.params.id), session.user_id, readVersion(req.body?.version));
      return res.json({ project: serializeProject(project) });
    } catch (error) {
      return sendTaskboardError(res, error);
    }
  });

  api.post("/taskboard/projects/:id/tasks", (req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    try {
      const priority = req.body?.priority ?? "medium";
      const risk = req.body?.risk ?? "medium";
      if (!isTaskboardPriority(priority)) throw new TaskboardValidationError("任务优先级无效。");
      if (!isTaskboardRisk(risk)) throw new TaskboardValidationError("任务风险等级无效。");
      const estimatePoints = req.body?.estimatePoints === undefined || req.body?.estimatePoints === null
        ? null
        : readInteger(req.body.estimatePoints, "工作量", 1, 100);
      const task = store.createTask(String(req.params.id), session.user_id, {
        title: readRequiredText(req.body?.title, "任务标题", 160),
        description: readOptionalText(req.body?.description, "任务说明", 30_000),
        parentTaskId: readNullableId(req.body?.parentTaskId, "父任务"),
        priority,
        risk,
        estimatePoints,
        acceptanceCriteria: readOptionalText(req.body?.acceptanceCriteria, "验收标准", 15_000),
        conversationId: readNullableId(req.body?.conversationId, "关联会话"),
      });
      return res.status(201).json({ task: serializeTaskWithState(store, task, session.user_id) });
    } catch (error) {
      return sendTaskboardError(res, error);
    }
  });

  api.patch("/taskboard/tasks/:id", (req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    try {
      const input: {
        title?: string;
        description?: string;
        parentTaskId?: string | null;
        priority?: "urgent" | "high" | "medium" | "low";
        risk?: "low" | "medium" | "high";
        estimatePoints?: number | null;
        acceptanceCriteria?: string;
        conversationId?: string | null;
      } = {};
      if (Object.hasOwn(req.body ?? {}, "title")) input.title = readRequiredText(req.body.title, "任务标题", 160);
      if (Object.hasOwn(req.body ?? {}, "description")) input.description = readOptionalText(req.body.description, "任务说明", 30_000);
      if (Object.hasOwn(req.body ?? {}, "parentTaskId")) input.parentTaskId = readNullableId(req.body.parentTaskId, "父任务");
      if (Object.hasOwn(req.body ?? {}, "priority")) {
        if (!isTaskboardPriority(req.body.priority)) throw new TaskboardValidationError("任务优先级无效。");
        input.priority = req.body.priority;
      }
      if (Object.hasOwn(req.body ?? {}, "risk")) {
        if (!isTaskboardRisk(req.body.risk)) throw new TaskboardValidationError("任务风险等级无效。");
        input.risk = req.body.risk;
      }
      if (Object.hasOwn(req.body ?? {}, "estimatePoints")) {
        input.estimatePoints = req.body.estimatePoints === null ? null : readInteger(req.body.estimatePoints, "工作量", 1, 100);
      }
      if (Object.hasOwn(req.body ?? {}, "acceptanceCriteria")) {
        input.acceptanceCriteria = readOptionalText(req.body.acceptanceCriteria, "验收标准", 15_000);
      }
      if (Object.hasOwn(req.body ?? {}, "conversationId")) input.conversationId = readNullableId(req.body.conversationId, "关联会话");
      if (Object.keys(input).length === 0) throw new TaskboardValidationError("没有可更新的任务字段。");
      const task = store.updateTask(String(req.params.id), session.user_id, readVersion(req.body?.version), input);
      return res.json({ task: serializeTaskWithState(store, task, session.user_id) });
    } catch (error) {
      return sendTaskboardError(res, error);
    }
  });

  api.post("/taskboard/tasks/:id/start", (req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    try {
      const id = String(req.params.id);
      const task = store.getTask(id, session.user_id);
      if (!task) throw new TaskboardNotFoundError("任务不存在。");
      if (task.executor_kind === "remote" && (!task.remote_project_id || !gateway.hasProject(task.remote_project_id))) {
        return res.status(409).json({ error: "任务对应的远端项目当前离线；不会回退到 Tenant。" });
      }
      const started = store.startTask(id, session.user_id, readVersion(req.body?.version), options.selectionForTask(task, session.user_id));
      options.onJobQueued();
      return res.status(202).json({
        task: serializeTaskWithState(store, started.task, session.user_id),
        job: { id: started.job.id, status: started.job.status, conversationId: started.conversationId },
      });
    } catch (error) {
      return sendTaskboardError(res, error);
    }
  });

  api.delete("/taskboard/tasks/:id", (req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    try {
      const task = store.archiveTask(String(req.params.id), session.user_id, readVersion(req.body?.version));
      return res.json({ task: { ...serializeTask(task), executionStatus: null, jobId: null, allowedTransitions: [] } });
    } catch (error) {
      return sendTaskboardError(res, error);
    }
  });

  api.post("/taskboard/tasks/:id/transition", (req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    try {
      if (!isTaskboardStatus(req.body?.status)) throw new TaskboardValidationError("目标任务状态无效。");
      const task = store.transitionTask(
        String(req.params.id), session.user_id, readVersion(req.body?.version), req.body.status,
        readOptionalText(req.body?.reason, "状态说明", 2_000),
      );
      return res.json({ task: serializeTaskWithState(store, task, session.user_id) });
    } catch (error) {
      return sendTaskboardError(res, error);
    }
  });

  api.put("/taskboard/tasks/:id/dependencies", (req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    try {
      if (!Array.isArray(req.body?.dependencyIds) || req.body.dependencyIds.length > 100) {
        throw new TaskboardValidationError("依赖列表无效或数量过多。");
      }
      const dependencyIds = req.body.dependencyIds.map((value: unknown) => readId(value, "依赖任务"));
      const task = store.replaceDependencies(String(req.params.id), session.user_id, readVersion(req.body?.version), dependencyIds);
      return res.json({ task: serializeTaskWithState(store, task, session.user_id) });
    } catch (error) {
      return sendTaskboardError(res, error);
    }
  });

  api.get("/taskboard/tasks/:id/events", (req, res) => {
    const session = requireOwner(res);
    if (!session) return;
    try {
      const events = store.listEvents(String(req.params.id), session.user_id).map((event) => ({
        ...event,
        payload: parsePayload(event.payload),
      }));
      return res.json({ events });
    } catch (error) {
      return sendTaskboardError(res, error);
    }
  });
}

function requireOwner(res: Response): SessionRow | undefined {
  const session = res.locals.session as SessionRow | undefined;
  if (!session) {
    res.status(401).json({ error: "请先登录。" });
    return undefined;
  }
  if (session.role !== "owner") {
    res.status(403).json({ error: "只有所有者可以管理智能项目看板。" });
    return undefined;
  }
  return session;
}

function readExecutor(value: unknown): TaskboardExecutorTarget {
  if (!value || typeof value !== "object") throw new TaskboardValidationError("项目执行位置无效。");
  const input = value as { kind?: unknown; projectId?: unknown };
  if (input.kind === "tenant") return { kind: "tenant" };
  if (input.kind !== "remote" || typeof input.projectId !== "string") {
    throw new TaskboardValidationError("项目执行位置无效。");
  }
  const projectId = input.projectId.trim();
  if (!SAFE_PROJECT_ID.test(projectId)) throw new TaskboardValidationError("远端项目标识无效。");
  return { kind: "remote", projectId };
}

function readVersion(value: unknown): number {
  return readInteger(value, "数据版本", 1, Number.MAX_SAFE_INTEGER);
}

function readInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TaskboardValidationError(`${label}无效。`);
  }
  return Number(value);
}

function readRequiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TaskboardValidationError(`${label}不能为空。`);
  const text = value.trim();
  if (!text) throw new TaskboardValidationError(`${label}不能为空。`);
  if (text.length > maximum) throw new TaskboardValidationError(`${label}不能超过 ${maximum} 个字符。`);
  return text;
}

function readOptionalText(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new TaskboardValidationError(`${label}无效。`);
  const text = value.trim();
  if (text.length > maximum) throw new TaskboardValidationError(`${label}不能超过 ${maximum} 个字符。`);
  return text;
}

function readNullableId(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return readId(value, label);
}

function readId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(value)) {
    throw new TaskboardValidationError(`${label}无效。`);
  }
  return value;
}

function serializeProject(project: ReturnType<TaskboardStore["createProject"]>) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    executor: project.executor_kind === "remote"
      ? { kind: "remote" as const, projectId: project.remote_project_id! }
      : { kind: "tenant" as const },
    automationMode: project.automation_mode,
    maxConcurrency: project.max_concurrency,
    version: project.version,
    archivedAt: project.archived_at,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

function serializeTask(task: ReturnType<TaskboardStore["createTask"]>) {
  return {
    id: task.id,
    projectId: task.project_id,
    parentTaskId: task.parent_task_id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    risk: task.risk,
    estimatePoints: task.estimate_points,
    acceptanceCriteria: task.acceptance_criteria,
    position: task.position,
    conversationId: task.conversation_id,
    executor: task.executor_kind === "remote"
      ? { kind: "remote" as const, projectId: task.remote_project_id! }
      : { kind: "tenant" as const },
    version: task.version,
    archivedAt: task.archived_at,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

function serializeTaskWithState(store: TaskboardStore, task: TaskboardTaskRow, userId: string) {
  const execution = store.getTaskExecution(task.id, userId);
  return {
    ...serializeTask(task),
    executionStatus: execution?.status ?? null,
    jobId: execution?.jobId ?? null,
    allowedTransitions: transitionTargets(task.status),
  };
}

function parsePayload(payload: string): unknown {
  try { return JSON.parse(payload); }
  catch { return {}; }
}

function sendTaskboardError(res: Response, error: unknown) {
  if (error instanceof TaskboardNotFoundError) return res.status(404).json({ error: error.message });
  if (error instanceof TaskboardConflictError) return res.status(409).json({ error: error.message });
  if (error instanceof TaskboardValidationError) return res.status(400).json({ error: error.message });
  throw error;
}
