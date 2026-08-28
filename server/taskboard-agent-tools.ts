import type { AppDatabase } from "./db.js";
import type {
  DynamicToolCallRequest,
  DynamicToolExecutionResult,
  DynamicToolHandler,
  DynamicToolNamespaceTool,
  DynamicToolSpec,
} from "./app-server-dynamic-tools.js";
import {
  isTaskboardPriority,
  isTaskboardRisk,
  type TaskboardStatus,
} from "./taskboard-policy.js";
import {
  TaskboardStore,
  TaskboardValidationError,
  type CreateTaskInput,
  type TaskboardExecutorTarget,
  type UpdateTaskInput,
} from "./taskboard-store.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AGENT_TRANSITIONS = new Set<TaskboardStatus>(["backlog", "ready", "blocked"]);

const taskboardTools: DynamicToolSpec = {
  type: "namespace",
  name: "taskboard",
  description: "读取和编辑当前 Owner 的智能项目看板。可规划项目、任务和依赖，但不能启动、验收完成、取消或归档任务。",
  tools: [
    tool("list_projects", "列出当前 Owner 的全部未归档智能看板项目。", {}),
    tool("get_project", "读取一个项目、全部任务卡和依赖关系。修改前应先读取，以获得最新 version。", {
      projectId: stringSchema("项目 ID"),
    }, ["projectId"]),
    tool("create_project", "创建一个使用当前会话执行位置的新项目。不能替用户选择其他远端执行器。", {
      name: stringSchema("项目名称", 120),
      description: stringSchema("项目说明", 20_000),
    }, ["name"]),
    tool("update_project", "更新项目名称、说明或并发上限。必须使用 get_project 返回的最新 version。", {
      projectId: stringSchema("项目 ID"),
      version: integerSchema("项目版本", 1),
      name: stringSchema("项目名称", 120),
      description: stringSchema("项目说明", 20_000),
      maxConcurrency: integerSchema("最大并发数", 1, 8),
    }, ["projectId", "version"]),
    tool("create_tasks", "一次创建 1 到 50 张待规划任务卡。任务创建在 backlog；不会自动启动。", {
      projectId: stringSchema("项目 ID"),
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: stringSchema("任务标题", 160),
            description: stringSchema("任务说明", 30_000),
            parentTaskId: nullableStringSchema("父任务 ID"),
            priority: { type: "string", enum: ["urgent", "high", "medium", "low"] },
            risk: { type: "string", enum: ["low", "medium", "high"] },
            estimatePoints: nullableIntegerSchema("工作量", 1, 100),
            acceptanceCriteria: stringSchema("验收标准", 15_000),
          },
        },
      },
    }, ["projectId", "tasks"]),
    tool("update_task", "编辑尚未进入实际工作的任务卡。必须使用 get_project 返回的最新 version。", {
      taskId: stringSchema("任务 ID"),
      version: integerSchema("任务版本", 1),
      title: stringSchema("任务标题", 160),
      description: stringSchema("任务说明", 30_000),
      parentTaskId: nullableStringSchema("父任务 ID"),
      priority: { type: "string", enum: ["urgent", "high", "medium", "low"] },
      risk: { type: "string", enum: ["low", "medium", "high"] },
      estimatePoints: nullableIntegerSchema("工作量", 1, 100),
      acceptanceCriteria: stringSchema("验收标准", 15_000),
    }, ["taskId", "version"]),
    tool("set_dependencies", "替换任务的全部前置依赖。只能用于尚未进入实际工作的任务。", {
      taskId: stringSchema("任务 ID"),
      version: integerSchema("任务版本", 1),
      dependencyIds: {
        type: "array",
        maxItems: 100,
        uniqueItems: true,
        items: stringSchema("依赖任务 ID"),
      },
    }, ["taskId", "version", "dependencyIds"]),
    tool("transition_task", "只在 backlog、ready、blocked 三种规划状态间移动任务。不能启动、完成、取消或归档。", {
      taskId: stringSchema("任务 ID"),
      version: integerSchema("任务版本", 1),
      status: { type: "string", enum: ["backlog", "ready", "blocked"] },
      reason: stringSchema("状态说明", 2_000),
    }, ["taskId", "version", "status"]),
  ],
};

export type TaskboardAgentContext = {
  userId: string;
  executor: TaskboardExecutorTarget;
};

export class TaskboardAgentTools {
  constructor(private readonly db: AppDatabase, private readonly store: TaskboardStore) {}

  specsForUser(userId: string): DynamicToolSpec[] | undefined {
    return this.db.getUser(userId)?.role === "owner" ? [taskboardTools] : undefined;
  }

  handler(context: TaskboardAgentContext): DynamicToolHandler {
    return (call) => this.execute(call, context);
  }

  execute(call: DynamicToolCallRequest, context: TaskboardAgentContext): DynamicToolExecutionResult {
    try {
      if (this.db.getUser(context.userId)?.role !== "owner") throw new TaskboardValidationError("只有 Owner 可以编辑智能项目看板。");
      if (call.namespace !== "taskboard") throw new TaskboardValidationError("未知的内部工具命名空间。");
      const args = objectArgs(call.arguments);
      switch (call.tool) {
        case "list_projects":
          return ok({ projects: this.store.listProjects(context.userId) });
        case "get_project": {
          const projectId = readId(args.projectId, "项目");
          const project = this.store.getProject(projectId, context.userId);
          if (!project) throw new TaskboardValidationError("项目不存在。");
          return ok({
            project,
            tasks: this.store.listTasks(projectId, context.userId),
            dependencies: this.store.listDependencies(projectId, context.userId),
          });
        }
        case "create_project": {
          const project = this.store.createProject(context.userId, {
            name: readText(args.name, "项目名称", 120, true),
            description: readText(args.description, "项目说明", 20_000),
            executor: context.executor,
          });
          return ok({ project });
        }
        case "update_project": {
          const input: { name?: string; description?: string; maxConcurrency?: number } = {};
          if (has(args, "name")) input.name = readText(args.name, "项目名称", 120, true);
          if (has(args, "description")) input.description = readText(args.description, "项目说明", 20_000);
          if (has(args, "maxConcurrency")) input.maxConcurrency = readInteger(args.maxConcurrency, "并发上限", 1, 8);
          if (Object.keys(input).length === 0) throw new TaskboardValidationError("没有可更新的项目字段。");
          return ok({ project: this.store.updateProject(readId(args.projectId, "项目"), context.userId, readVersion(args.version), input) });
        }
        case "create_tasks": {
          const values = args.tasks;
          if (!Array.isArray(values) || values.length < 1 || values.length > 50) throw new TaskboardValidationError("任务数量必须为 1 到 50。");
          const inputs = values.map((value, index) => readCreateTask(value, index));
          return ok({ tasks: this.store.createTasks(readId(args.projectId, "项目"), context.userId, inputs) });
        }
        case "update_task": {
          const input = readUpdateTask(args);
          return ok({ task: this.store.updateTask(readId(args.taskId, "任务"), context.userId, readVersion(args.version), input) });
        }
        case "set_dependencies": {
          if (!Array.isArray(args.dependencyIds) || args.dependencyIds.length > 100) throw new TaskboardValidationError("依赖列表无效或数量过多。");
          const dependencyIds = args.dependencyIds.map((value) => readId(value, "依赖任务"));
          return ok({ task: this.store.replaceDependencies(readId(args.taskId, "任务"), context.userId, readVersion(args.version), dependencyIds) });
        }
        case "transition_task": {
          if (typeof args.status !== "string" || !AGENT_TRANSITIONS.has(args.status as TaskboardStatus)) {
            throw new TaskboardValidationError("Agent 只能切换 backlog、ready 或 blocked 规划状态；启动与最终验收由 Owner 操作。");
          }
          return ok({
            task: this.store.transitionTask(
              readId(args.taskId, "任务"), context.userId, readVersion(args.version), args.status as TaskboardStatus,
              readText(args.reason, "状态说明", 2_000),
            ),
          });
        }
        default:
          throw new TaskboardValidationError("未知的智能看板工具。");
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "智能看板操作失败。" };
    }
  }
}

function readCreateTask(value: unknown, index: number): CreateTaskInput {
  const input = objectArgs(value, `第 ${index + 1} 张任务卡无效。`);
  const priority = input.priority ?? "medium";
  const risk = input.risk ?? "medium";
  if (!isTaskboardPriority(priority)) throw new TaskboardValidationError(`第 ${index + 1} 张任务卡的优先级无效。`);
  if (!isTaskboardRisk(risk)) throw new TaskboardValidationError(`第 ${index + 1} 张任务卡的风险等级无效。`);
  return {
    title: readText(input.title, "任务标题", 160, true),
    description: readText(input.description, "任务说明", 30_000),
    parentTaskId: readNullableId(input.parentTaskId, "父任务"),
    priority,
    risk,
    estimatePoints: has(input, "estimatePoints") && input.estimatePoints !== null
      ? readInteger(input.estimatePoints, "工作量", 1, 100)
      : null,
    acceptanceCriteria: readText(input.acceptanceCriteria, "验收标准", 15_000),
  };
}

function readUpdateTask(args: Record<string, unknown>): UpdateTaskInput {
  const input: UpdateTaskInput = {};
  if (has(args, "title")) input.title = readText(args.title, "任务标题", 160, true);
  if (has(args, "description")) input.description = readText(args.description, "任务说明", 30_000);
  if (has(args, "parentTaskId")) input.parentTaskId = readNullableId(args.parentTaskId, "父任务");
  if (has(args, "priority")) {
    if (!isTaskboardPriority(args.priority)) throw new TaskboardValidationError("任务优先级无效。");
    input.priority = args.priority;
  }
  if (has(args, "risk")) {
    if (!isTaskboardRisk(args.risk)) throw new TaskboardValidationError("任务风险等级无效。");
    input.risk = args.risk;
  }
  if (has(args, "estimatePoints")) input.estimatePoints = args.estimatePoints === null
    ? null
    : readInteger(args.estimatePoints, "工作量", 1, 100);
  if (has(args, "acceptanceCriteria")) input.acceptanceCriteria = readText(args.acceptanceCriteria, "验收标准", 15_000);
  if (Object.keys(input).length === 0) throw new TaskboardValidationError("没有可更新的任务字段。");
  return input;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): DynamicToolNamespaceTool {
  return {
    type: "function",
    name,
    description,
    inputSchema: { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) },
  };
}

function stringSchema(description: string, maxLength = 128): Record<string, unknown> {
  return { type: "string", description, maxLength };
}

function nullableStringSchema(description: string): Record<string, unknown> {
  return { type: ["string", "null"], description, maxLength: 128 };
}

function integerSchema(description: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): Record<string, unknown> {
  return { type: "integer", description, minimum, maximum };
}

function nullableIntegerSchema(description: string, minimum: number, maximum: number): Record<string, unknown> {
  return { type: ["integer", "null"], description, minimum, maximum };
}

function objectArgs(value: unknown, message = "工具参数必须是对象。"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskboardValidationError(message);
  return value as Record<string, unknown>;
}

function readText(value: unknown, label: string, maximum: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new TaskboardValidationError(`${label}不能为空。`);
    return "";
  }
  if (typeof value !== "string") throw new TaskboardValidationError(`${label}无效。`);
  const text = value.trim();
  if ((required && !text) || text.length > maximum) throw new TaskboardValidationError(`${label}不能为空或长度超出限制。`);
  return text;
}

function readId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value.trim())) throw new TaskboardValidationError(`${label} ID 无效。`);
  return value.trim();
}

function readNullableId(value: unknown, label: string): string | null {
  return value === undefined || value === null || value === "" ? null : readId(value, label);
}

function readVersion(value: unknown): number {
  return readInteger(value, "数据版本", 1, Number.MAX_SAFE_INTEGER);
}

function readInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new TaskboardValidationError(`${label}无效。`);
  return Number(value);
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function ok(value: unknown): DynamicToolExecutionResult {
  return { success: true, value };
}
