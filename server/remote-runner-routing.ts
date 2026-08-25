import type { CodexRunner } from "./codex-runner.js";
import { AppDatabase, type FileRow } from "./db.js";
import type { AgentSelection } from "./model-options.js";
import { newId } from "./paths.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { RemoteExecutorStore } from "./remote-executor-store.js";
import { RemoteWorkerGateway, type RemoteRunExecution } from "./remote-worker-gateway.js";

type Publish = (jobId: string, eventType: string, payload: unknown) => void;

type MutableRunner = {
  run(jobId: string, conversationId: string, prompt: string, uploads: FileRow[], selection: AgentSelection): Promise<void>;
  steer(jobId: string, prompt: string, uploads: FileRow[]): Promise<string>;
  cancel(jobId: string): boolean;
  conversationRolloutBytes(conversationId: string): number | null;
};

export type RemoteRunnerRoutingOptions = {
  gateway?: RemoteWorkerGateway;
  store: RemoteExecutorStore;
};

function autoTitle(prompt: string): string {
  const cleaned = prompt
    .replace(/\s+/g, " ")
    .replace(/^(?:请|麻烦|能否|可以)?(?:帮我|给我)?(?:一下)?/u, "")
    .trim() || "远程任务";
  return Array.from(cleaned).slice(0, 10).join("");
}

/**
 * Installs a narrow routing decorator on the existing CodexRunner instance.
 * The application queue already closes over this object, so replacing its
 * public methods keeps the upstream queue/UI code untouched. Tenant methods
 * remain the default path and are delegated to verbatim.
 */
export function installRemoteRunnerRouting(
  runner: CodexRunner,
  db: AppDatabase,
  options: RemoteRunnerRoutingOptions,
): void {
  const mutable = runner as unknown as MutableRunner;
  const publish = (runner as unknown as { publish?: Publish }).publish;
  if (typeof publish !== "function") throw new Error("CodexRunner publish hook is unavailable");

  const originalRun = mutable.run.bind(runner);
  const originalSteer = mutable.steer.bind(runner);
  const originalCancel = mutable.cancel.bind(runner);
  const originalRolloutBytes = mutable.conversationRolloutBytes.bind(runner);
  const prototype = Object.getPrototypeOf(runner) as object;
  const activeDescriptor = Object.getOwnPropertyDescriptor(prototype, "activeJobCount");
  const tenantActiveJobCount = () => Number(activeDescriptor?.get?.call(runner) ?? 0);

  const remoteExecutions = new Map<string, RemoteRunExecution>();
  const userCancelled = new Set<string>();

  Object.defineProperty(runner, "activeJobCount", {
    configurable: true,
    get: () => tenantActiveJobCount() + remoteExecutions.size,
  });

  mutable.conversationRolloutBytes = (conversationId: string): number | null => {
    return options.store.get(conversationId).kind === "remote" ? null : originalRolloutBytes(conversationId);
  };

  mutable.cancel = (jobId: string): boolean => {
    const remote = remoteExecutions.get(jobId);
    if (!remote) return originalCancel(jobId);
    userCancelled.add(jobId);
    remote.interrupt();
    return true;
  };

  mutable.steer = async (jobId: string, prompt: string, uploads: FileRow[]): Promise<string> => {
    const remote = remoteExecutions.get(jobId);
    if (!remote) return originalSteer(jobId, prompt, uploads);
    if (uploads.length > 0) throw new Error("远端任务暂不支持在实时引导中追加附件");
    const turnId = await remote.steer(prompt);
    publish(jobId, "progress", { kind: "status", label: "远端 Codex 已收到实时引导，正在调整当前任务" });
    return turnId;
  };

  mutable.run = async (
    jobId: string,
    conversationId: string,
    prompt: string,
    uploads: FileRow[],
    selection: AgentSelection,
  ): Promise<void> => {
    const target = options.store.get(conversationId);
    if (target.kind === "tenant") return originalRun(jobId, conversationId, prompt, uploads, selection);

    try {
      const conversation = db.getConversation(conversationId);
      if (!conversation) throw new Error("会话不存在");
      if (!options.gateway) throw new Error("远端执行服务未启用，请配置 REMOTE_WORKER_TOKEN 后重启服务");
      if (uploads.length > 0) throw new Error("远端项目执行暂不支持会话附件，请先把所需文件放到远端项目目录中");

      db.updateJob(jobId, "running");
      db.updateConversation(conversationId, { status: "running" });
      publish(jobId, "status", {
        status: "running",
        label: `正在远端项目 ${target.projectId} 中处理`,
      });

      const execution = options.gateway.start({
        jobId,
        projectId: target.projectId,
        prompt,
        ...(conversation.codex_thread_id ? { codexThreadId: conversation.codex_thread_id } : {}),
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      }, {
        onThreadStarted: (threadId) => db.updateConversation(conversationId, { codexThreadId: threadId }),
        onProgress: (payload) => publish(jobId, "progress", payload),
      });
      remoteExecutions.set(jobId, execution);

      const rawFinalResponse = await execution.result;
      const messageId = newId();
      const createdAt = new Date().toISOString();
      const safeFinalResponse = sanitizeAgentMarkdown(rawFinalResponse, db.listFiles(conversationId));
      db.addMessage({
        id: messageId,
        conversation_id: conversationId,
        role: "assistant",
        content: safeFinalResponse || "远端任务已完成。",
        created_at: createdAt,
      });
      if (conversation.title_source === "default") db.setAiConversationTitleIfDefault(conversationId, autoTitle(prompt));
      db.finishJob(jobId, conversationId, "completed");
      publish(jobId, "done", { status: "completed" });
    } catch (error) {
      const cancelled = userCancelled.has(jobId);
      const message = cancelled
        ? "任务已停止"
        : error instanceof Error ? error.message : "远端 Agent 任务失败";
      try { db.finishJob(jobId, conversationId, cancelled ? "cancelled" : "failed", message); }
      catch { /* Database recovery will reconcile an interrupted job on restart. */ }
      try {
        publish(jobId, cancelled ? "done" : "failed", {
          status: cancelled ? "cancelled" : "failed",
          message,
        });
      } catch { /* Keep transport failures from crashing the process. */ }
    } finally {
      remoteExecutions.delete(jobId);
      userCancelled.delete(jobId);
    }
  };
}
