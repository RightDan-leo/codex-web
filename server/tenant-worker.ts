import readline from "node:readline";
import crypto from "node:crypto";
import { startTenantTurn, validateTenantWorkerRequest } from "./tenant-worker-execution.js";
import type { AppServerTurnExecution } from "./app-server-turn.js";
import type { TenantWorkerEvent, TenantWorkerInput } from "./tenant-worker-protocol.js";
import { cleanupJobRuntime } from "./python-runtime.js";
import { dynamicToolFailure, type DynamicToolExecutionResult } from "./app-server-dynamic-tools.js";

const expectedUserId = process.env.CWW_TENANT_USER_ID ?? "";
const expectedTenantRoot = process.env.CWW_TENANT_ROOT ?? "";
const expectedUid = Number(process.env.CWW_TENANT_UID ?? "NaN");
const expectedGid = Number(process.env.CWW_TENANT_GID ?? "NaN");
const controller = new AbortController();
let started = false;
let activeExecution: AppServerTurnExecution | null = null;
const pendingTools = new Map<string, { resolve(result: DynamicToolExecutionResult): void; timer: ReturnType<typeof setTimeout> }>();

function send(event: TenantWorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message: TenantWorkerInput;
  try {
    message = JSON.parse(line) as TenantWorkerInput;
  } catch {
    send({ type: "failed", message: "Invalid worker input" });
    process.exitCode = 1;
    return;
  }
  if (message.type === "cancel") {
    controller.abort();
    activeExecution?.interrupt();
    return;
  }
  if (message.type === "steer") {
    if (!activeExecution) {
      send({ type: "steer_failed", requestId: message.requestId, message: "当前任务尚未开始或已经结束" });
      return;
    }
    void activeExecution.steer(message.prompt, message.imagePaths).then(
      (turnId) => send({ type: "steer_completed", requestId: message.requestId, turnId }),
      (error) => send({ type: "steer_failed", requestId: message.requestId, message: error instanceof Error ? error.message : "引导失败" }),
    );
    return;
  }
  if (message.type === "tool_result") {
    const pending = pendingTools.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingTools.delete(message.requestId);
    pending.resolve(message.result);
    return;
  }
  if (message.type !== "run" || started) return;
  started = true;
  void (async () => {
    let terminalEvent: Extract<TenantWorkerEvent, { type: "completed" | "failed" }>;
    try {
      if (process.platform !== "win32" && (process.getuid?.() !== expectedUid || process.getgid?.() !== expectedGid)) {
        throw new Error("Worker Unix identity mismatch");
      }
      validateTenantWorkerRequest(message.request, expectedUserId, expectedTenantRoot);
      activeExecution = startTenantTurn(message.request, {
        signal: controller.signal,
        onAuthReady: () => send({ type: "auth_ready" }),
        onThreadStarted: (threadId) => send({ type: "thread_started", threadId }),
        onContextUsage: (usage) => send({ type: "context_usage", usage }),
        onQuotaUsage: (usage) => send({ type: "quota_usage", usage }),
        onProgress: (payload) => send({ type: "progress", payload }),
        onDynamicToolCall: (call) => new Promise((resolve) => {
          const requestId = crypto.randomUUID();
          const timer = setTimeout(() => {
            pendingTools.delete(requestId);
            resolve(dynamicToolFailure("智能看板操作等待主服务响应超时。"));
          }, 30_000);
          pendingTools.set(requestId, { resolve, timer });
          send({ type: "dynamic_tool_call", requestId, call });
        }),
      });
      const finalResponse = await activeExecution.result;
      terminalEvent = { type: "completed", finalResponse };
      process.exitCode = 0;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      terminalEvent = {
        type: "failed",
        message: cancelled ? "任务已停止" : error instanceof Error ? error.message : "Agent 任务失败",
        cancelled,
      };
      process.exitCode = cancelled ? 0 : 1;
    } finally {
      for (const [requestId, pending] of pendingTools) {
        clearTimeout(pending.timer);
        pending.resolve(dynamicToolFailure("任务已经结束，智能看板操作未执行。"));
        pendingTools.delete(requestId);
      }
      activeExecution = null;
      cleanupJobRuntime(message.request.runtimeRoot);
      send(terminalEvent!);
      input.close();
    }
  })();
});

input.on("close", () => {
  if (!started) process.exitCode = 1;
});
