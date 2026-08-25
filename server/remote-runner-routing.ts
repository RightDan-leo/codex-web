import type { CodexRunner } from "./codex-runner.js";
import { parseAutoTitleResponse, redactBrandForDisplay } from "./codex-runner.js";
import type { AppDatabase, FileRow } from "./db.js";
import type { AgentSelection } from "./model-options.js";
import { buildAgentSteerPrompt, buildAgentTurnPrompt } from "./agent-context.js";
import { latestUserCancellationContext } from "./cancellation-summary.js";
import { newId } from "./paths.js";
import { buildRemoteAttachmentPayloads } from "./remote-attachment-payload.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { RemoteExecutorStore } from "./remote-executor-store.js";
import { RemoteWorkerGateway, type RemoteRunExecution } from "./remote-worker-gateway.js";

type Publish = (jobId: string, eventType: string, payload: unknown) => void;

type RemoteActiveRun = {
  controller: AbortController;
  execution: RemoteRunExecution;
};

export type RemoteRunnerRoutingOptions = {
  gateway: RemoteWorkerGateway;
  store: RemoteExecutorStore;
  publish: Publish;
  workspaceForConversation?(conversationId: string, userId: string): string;
};

/**
 * Explicit runner decorator. The application closes over this object from the
 * start, so tenant behavior stays unchanged without mutating CodexRunner
 * methods, reading private fields, or replacing prototype accessors.
 */
export class RemoteRoutingRunner {
  private readonly remoteExecutions = new Map<string, RemoteActiveRun>();

  constructor(
    private readonly tenantRunner: CodexRunner,
    private readonly db: AppDatabase,
    private readonly options: RemoteRunnerRoutingOptions,
  ) {}

  get activeJobCount(): number {
    return this.tenantRunner.activeJobCount + this.remoteExecutions.size;
  }

  get activeRemoteJobCount(): number {
    return this.remoteExecutions.size;
  }

  conversationRolloutBytes(conversationId: string): number | null {
    return this.options.store.get(conversationId).kind === "remote"
      ? null
      : this.tenantRunner.conversationRolloutBytes(conversationId);
  }

  cancel(jobId: string): boolean {
    const remote = this.remoteExecutions.get(jobId);
    if (!remote) return this.tenantRunner.cancel(jobId);
    remote.controller.abort();
    return true;
  }

  async steer(jobId: string, prompt: string, uploads: FileRow[]): Promise<string> {
    const job = this.db.getJob(jobId);
    if (!job || job.status !== "running") throw new Error("当前任务已经结束，无法引导");
    const target = this.options.store.get(job.conversation_id);
    if (target.kind === "tenant") return this.tenantRunner.steer(jobId, prompt, uploads);
    if (uploads.length > 0) throw new Error("远端任务暂不支持在实时引导中追加附件");
    const remote = this.remoteExecutions.get(jobId);
    if (!remote) throw new Error("远端任务尚未进入可引导状态，请稍后重试");
    const turnId = await remote.execution.steer(buildAgentSteerPrompt(prompt, []));
    this.options.publish(jobId, "progress", { kind: "status", label: "远端 Codex 已收到实时引导，正在调整当前任务" });
    return turnId;
  }

  async run(
    jobId: string,
    conversationId: string,
    prompt: string,
    uploads: FileRow[],
    selection: AgentSelection,
  ): Promise<void> {
    const target = this.options.store.get(conversationId);
    if (target.kind === "tenant") return this.tenantRunner.run(jobId, conversationId, prompt, uploads, selection);

    const controller = new AbortController();
    try {
      const conversation = this.db.getConversation(conversationId);
      if (!conversation) throw new Error("会话不存在");
      const job = this.db.getJob(jobId);
      const shouldGenerateTitle = conversation.title_source === "default"
        && Boolean(job?.message_id && this.db.isFirstUserMessage(conversationId, job.message_id));
      if (!this.options.gateway.hasProject(target.projectId)) throw new Error(`远端项目当前离线：${target.projectId}`);

      const effectivePrompt = buildAgentTurnPrompt({
        userPrompt: prompt,
        attachments: [],
        interruptedContext: latestUserCancellationContext(this.db.listMessages(conversationId)),
      });
      let attachments = [] as Awaited<ReturnType<typeof buildRemoteAttachmentPayloads>>;
      if (uploads.length > 0) {
        if (!this.options.workspaceForConversation) throw new Error("服务器未配置远端附件工作区解析器");
        this.options.publish(jobId, "status", {
          status: "running",
          label: `正在安全打包 ${uploads.length} 个远端附件`,
          executor: { kind: "remote", projectId: target.projectId },
        });
        const workspace = this.options.workspaceForConversation(conversationId, conversation.user_id);
        attachments = await buildRemoteAttachmentPayloads(workspace, uploads);
      }

      this.db.updateJob(jobId, "running");
      this.db.updateConversation(conversationId, { status: "running" });
      this.options.publish(jobId, "status", {
        status: "running",
        label: `正在远端项目 ${target.projectId} 中处理`,
        executor: { kind: "remote", projectId: target.projectId },
        attachmentCount: attachments.length,
      });

      const execution = this.options.gateway.start({
        jobId,
        projectId: target.projectId,
        prompt: effectivePrompt,
        ...(conversation.codex_thread_id ? { codexThreadId: conversation.codex_thread_id } : {}),
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        ...(attachments.length > 0 ? { attachments } : {}),
      }, {
        onThreadStarted: (threadId) => this.db.updateConversation(conversationId, { codexThreadId: threadId }),
        onProgress: (payload) => this.options.publish(jobId, "progress", payload),
      });
      this.remoteExecutions.set(jobId, { controller, execution });
      controller.signal.addEventListener("abort", () => execution.interrupt(), { once: true });

      const rawFinalResponse = await execution.result;
      if (controller.signal.aborted) throw abortError();
      this.options.publish(jobId, "status", { status: "running", label: "远端任务已完成，正在整理结果" });

      const messageId = newId();
      const createdAt = new Date().toISOString();
      const safeFinalResponse = sanitizeAgentMarkdown(rawFinalResponse, this.db.listFiles(conversationId));
      this.db.addMessage({
        id: messageId,
        conversation_id: conversationId,
        role: "assistant",
        content: safeFinalResponse || "远端任务已完成。",
        created_at: createdAt,
      });
      if (shouldGenerateTitle) this.db.setAiConversationTitleIfDefault(conversationId, parseAutoTitleResponse("", prompt).title);
      this.db.finishJob(jobId, conversationId, "completed");
      this.options.publish(jobId, "done", {
        status: "completed",
        executor: { kind: "remote", projectId: target.projectId },
        attachmentCount: attachments.length,
        deliverables: "remote-project",
      });
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      const message = cancelled
        ? "任务已停止"
        : error instanceof Error ? redactBrandForDisplay(error.message) : "远端 Agent 任务失败";
      try { this.db.finishJob(jobId, conversationId, cancelled ? "cancelled" : "failed", message); }
      catch { /* Database recovery will reconcile an interrupted job on restart. */ }
      try {
        this.options.publish(jobId, cancelled ? "done" : "failed", {
          status: cancelled ? "cancelled" : "failed",
          message,
          executor: { kind: "remote", projectId: target.projectId },
        });
      } catch { /* Keep transport failures from crashing the process. */ }
    } finally {
      this.remoteExecutions.delete(jobId);
    }
  }

  close(): void {
    for (const remote of this.remoteExecutions.values()) remote.controller.abort();
  }
}

function abortError(): Error {
  const error = new Error("任务已停止");
  error.name = "AbortError";
  return error;
}
