import type { CodexRunner } from "./codex-runner.js";
import { parseAutoTitleResponse, redactBrandForDisplay } from "./codex-runner.js";
import type { AppDatabase, FileRow } from "./db.js";
import type { AgentSelection } from "./model-options.js";
import { buildAgentSteerPrompt, buildAgentTurnPrompt } from "./agent-context.js";
import { latestUserCancellationContext } from "./cancellation-summary.js";
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

type RemoteActiveRun = {
  controller: AbortController;
  execution: RemoteRunExecution;
};

export type RemoteRunnerRoutingOptions = {
  gateway: RemoteWorkerGateway;
  store: RemoteExecutorStore;
  publish?: Publish;
};

export type RemoteRunnerRouting = {
  get activeRemoteJobCount(): number;
  close(): void;
};

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
): RemoteRunnerRouting {
  const mutable = runner as unknown as MutableRunner;
  const publish = options.publish ?? runnerPublish(runner);
  const originalRun = mutable.run.bind(runner);
  const originalSteer = mutable.steer.bind(runner);
  const originalCancel = mutable.cancel.bind(runner);
  const originalRolloutBytes = mutable.conversationRolloutBytes.bind(runner);
  const prototype = Object.getPrototypeOf(runner) as object;
  const activeDescriptor = Object.getOwnPropertyDescriptor(prototype, "activeJobCount");
  const tenantActiveJobCount = () => Number(activeDescriptor?.get?.call(runner) ?? 0);
  const remoteExecutions = new Map<string, RemoteActiveRun>();

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
    remote.controller.abort();
    return true;
  };

  mutable.steer = async (jobId: string, prompt: string, uploads: FileRow[]): Promise<string> => {
    const job = db.getJob(jobId);
    if (!job || job.status !== "running") throw new Error("当前任务已经结束，无法引导");
    const target = options.store.get(job.conversation_id);
    if (target.kind === "tenant") return originalSteer(jobId, prompt, uploads);
    if (uploads.length > 0) throw new Error("远端任务暂不支持在实时引导中追加附件");
    const remote = remoteExecutions.get(jobId);
    if (!remote) throw new Error("远端任务尚未进入可引导状态，请稍后重试");
    const turnId = await remote.execution.steer(buildAgentSteerPrompt(prompt, []));
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

    const controller = new AbortController();
    try {
      const conversation = db.getConversation(conversationId);
      if (!conversation) throw new Error("会话不存在");
      const job = db.getJob(jobId);
      const shouldGenerateTitle = conversation.title_source === "default"
        && Boolean(job?.message_id && db.isFirstUserMessage(conversationId, job.message_id));
      if (uploads.length > 0) {
        throw new Error("远端项目执行暂不支持会话附件，请先把所需文件放到远端项目目录中");
      }
      if (!options.gateway.hasProject(target.projectId)) throw new Error(`远端项目当前离线：${target.projectId}`);

      const effectivePrompt = buildAgentTurnPrompt({
        userPrompt: prompt,
        attachments: [],
        interruptedContext: latestUserCancellationContext(db.listMessages(conversationId)),
      });

      db.updateJob(jobId, "running");
      db.updateConversation(conversationId, { status: "running" });
      publish(jobId, "status", {
        status: "running",
        label: `正在远端项目 ${target.projectId} 中处理`,
        executor: { kind: "remote", projectId: target.projectId },
      });

      const execution = options.gateway.start({
        jobId,
        projectId: target.projectId,
        prompt: effectivePrompt,
        ...(conversation.codex_thread_id ? { codexThreadId: conversation.codex_thread_id } : {}),
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      }, {
        onThreadStarted: (threadId) => db.updateConversation(conversationId, { codexThreadId: threadId }),
        onProgress: (payload) => publish(jobId, "progress", payload),
      });
      remoteExecutions.set(jobId, { controller, execution });
      controller.signal.addEventListener("abort", () => {
        try { execution.interrupt(); }
        catch { /* The worker may already be disconnected. */ }
      }, { once: true });

      const rawFinalResponse = await execution.result;
      if (controller.signal.aborted) throw abortError();
      publish(jobId, "status", { status: "running", label: "远端任务已完成，正在整理结果" });

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
      if (shouldGenerateTitle) {
        db.setAiConversationTitleIfDefault(conversationId, parseAutoTitleResponse("", prompt).title);
      }
      db.finishJob(jobId, conversationId, "completed");
      publish(jobId, "done", {
        status: "completed",
        executor: { kind: "remote", projectId: target.projectId },
        deliverables: "remote-project",
      });
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      const message = cancelled
        ? "任务已停止"
        : error instanceof Error ? redactBrandForDisplay(error.message) : "远端 Agent 任务失败";
      try { db.finishJob(jobId, conversationId, cancelled ? "cancelled" : "failed", message); }
      catch { /* Database recovery will reconcile an interrupted job on restart. */ }
      try {
        publish(jobId, cancelled ? "done" : "failed", {
          status: cancelled ? "cancelled" : "failed",
          message,
          executor: { kind: "remote", projectId: target.projectId },
        });
      } catch { /* Keep transport failures from crashing the process. */ }
    } finally {
      remoteExecutions.delete(jobId);
    }
  };

  return {
    get activeRemoteJobCount() { return remoteExecutions.size; },
    close: () => {
      for (const remote of remoteExecutions.values()) remote.controller.abort();
    },
  };
}

function runnerPublish(runner: CodexRunner): Publish {
  const publish = (runner as unknown as { publish?: Publish }).publish;
  if (typeof publish !== "function") throw new Error("CodexRunner publish hook is unavailable");
  return publish.bind(runner);
}

function abortError(): Error {
  const error = new Error("任务已停止");
  error.name = "AbortError";
  return error;
}
