import { stageRemoteAttachments } from "./remote-attachment-staging.js";
import {
  REMOTE_ERROR_MAX_CHARS,
  REMOTE_PROGRESS_MAX_BYTES,
  REMOTE_RESULT_MAX_BYTES,
  REMOTE_WORKER_PROTOCOL_VERSION,
  type ServerToWorkerMessage,
  type WorkerToServerMessage,
  validateServerMessage,
} from "./remote-worker-protocol.js";

export type RemoteWorkerProject = {
  id: string;
  name: string;
  cwd: string;
  codexHome?: string;
};

export type RemoteCodexStartInput = {
  jobId: string;
  cwd: string;
  codexHome?: string;
  threadId?: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  runtimeRoot?: string;
  imagePaths?: string[];
};

export type RemoteCodexExecution = {
  result: Promise<string>;
  steer?(prompt: string): Promise<string | void> | string | void;
  interrupt?(): void;
};

export type RemoteCodexStarter = (
  input: RemoteCodexStartInput,
  callbacks: {
    onThreadStarted(threadId: string): void;
    onProgress(payload: unknown): void;
  },
) => RemoteCodexExecution;

export type WorkerEmit = (message: WorkerToServerMessage) => void;

type ActiveRun = {
  requestId: string;
  execution: RemoteCodexExecution;
  cancelled: boolean;
  cleanup(): void;
};

export class RemoteWorkerRuntime {
  private readonly projects = new Map<string, RemoteWorkerProject>();
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(projects: RemoteWorkerProject[], private readonly startCodex: RemoteCodexStarter) {
    for (const project of projects) {
      if (this.projects.has(project.id)) throw new Error(`Duplicate remote project id: ${project.id}`);
      if (!project.cwd) throw new Error(`Remote project cwd is required: ${project.id}`);
      this.projects.set(project.id, { ...project });
    }
  }

  get activeRunCount(): number {
    return this.activeRuns.size;
  }

  shutdown(): void {
    for (const active of this.activeRuns.values()) {
      active.cancelled = true;
      safeInterrupt(active.execution);
    }
  }

  async waitForIdle(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.activeRuns.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return this.activeRuns.size === 0;
  }

  async handle(rawMessage: unknown, emit: WorkerEmit): Promise<void> {
    const message: ServerToWorkerMessage = validateServerMessage(rawMessage);
    switch (message.type) {
      case "server.ping":
        emit({ type: "worker.pong", protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, requestId: message.requestId });
        return;
      case "server.run":
        await this.run(message, emit);
        return;
      case "server.steer":
        await this.steer(message.jobId, message.requestId, message.prompt, emit);
        return;
      case "server.cancel":
        this.cancel(message.jobId, message.requestId, emit);
        return;
    }
  }

  private async run(message: Extract<ServerToWorkerMessage, { type: "server.run" }>, emit: WorkerEmit): Promise<void> {
    if (this.activeRuns.has(message.jobId)) {
      emit({
        type: "worker.error",
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        requestId: message.requestId,
        jobId: message.jobId,
        message: "Remote job is already running",
      });
      return;
    }
    const project = this.projects.get(message.projectId);
    if (!project) {
      emit({
        type: "worker.error",
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        requestId: message.requestId,
        jobId: message.jobId,
        message: "Remote project is not registered on this worker",
      });
      return;
    }

    let staged: ReturnType<typeof stageRemoteAttachments> | undefined;
    let execution: RemoteCodexExecution | undefined;
    try {
      staged = stageRemoteAttachments(message.jobId, message.prompt, message.attachments);
      execution = this.startCodex({
        jobId: message.jobId,
        cwd: project.cwd,
        ...(project.codexHome ? { codexHome: project.codexHome } : {}),
        ...(message.codexThreadId ? { threadId: message.codexThreadId } : {}),
        prompt: staged.prompt,
        ...(message.model ? { model: message.model } : {}),
        ...(message.reasoningEffort ? { reasoningEffort: message.reasoningEffort } : {}),
        ...(staged.runtimeRoot ? { runtimeRoot: staged.runtimeRoot } : {}),
        ...(staged.imagePaths.length > 0 ? { imagePaths: staged.imagePaths } : {}),
      }, {
        onThreadStarted: (threadId) => emit({
          type: "worker.thread.started",
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          requestId: message.requestId,
          jobId: message.jobId,
          threadId,
        }),
        onProgress: (payload) => emit({
          type: "worker.progress",
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          requestId: message.requestId,
          jobId: message.jobId,
          payload: boundedProgress(payload),
        }),
      });
    } catch (error) {
      staged?.cleanup();
      emit({
        type: "worker.error",
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        requestId: message.requestId,
        jobId: message.jobId,
        message: remoteErrorMessage(error, "Unable to start remote Codex", [project.cwd, project.codexHome, staged?.runtimeRoot]),
      });
      return;
    }
    if (!staged || !execution) {
      staged?.cleanup();
      emit({
        type: "worker.error",
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        requestId: message.requestId,
        jobId: message.jobId,
        message: "Remote attachment staging did not initialize",
      });
      return;
    }

    const active: ActiveRun = {
      requestId: message.requestId,
      execution,
      cancelled: false,
      cleanup: staged.cleanup,
    };
    this.activeRuns.set(message.jobId, active);
    try {
      const result = await execution.result;
      if (!active.cancelled) {
        if (Buffer.byteLength(result, "utf8") > REMOTE_RESULT_MAX_BYTES) {
          emit({
            type: "worker.error",
            protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
            requestId: message.requestId,
            jobId: message.jobId,
            message: "Remote Codex result exceeds the response size limit",
          });
        } else {
          emit({
            type: "worker.result",
            protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
            requestId: message.requestId,
            jobId: message.jobId,
            result,
          });
        }
      }
    } catch (error) {
      if (!active.cancelled) {
        emit({
          type: "worker.error",
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          requestId: message.requestId,
          jobId: message.jobId,
          message: remoteErrorMessage(error, "Remote Codex failed", [project.cwd, project.codexHome, staged.runtimeRoot]),
        });
      }
    } finally {
      if (this.activeRuns.get(message.jobId) === active) this.activeRuns.delete(message.jobId);
      active.cleanup();
    }
  }

  private async steer(jobId: string, requestId: string, prompt: string, emit: WorkerEmit): Promise<void> {
    const active = this.activeRuns.get(jobId);
    if (!active || !active.execution.steer) {
      emit({
        type: "worker.error",
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        requestId,
        jobId,
        message: "Remote job cannot be steered",
      });
      return;
    }
    try {
      const turnId = await active.execution.steer(prompt);
      emit({
        type: "worker.steered",
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        requestId,
        jobId,
        ...(typeof turnId === "string" && turnId ? { turnId } : {}),
      });
    } catch (error) {
      emit({
        type: "worker.error",
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        requestId,
        jobId,
        message: remoteErrorMessage(error, "Unable to steer remote Codex"),
      });
    }
  }

  private cancel(jobId: string, requestId: string, emit: WorkerEmit): void {
    const active = this.activeRuns.get(jobId);
    if (!active) return;
    active.cancelled = true;
    safeInterrupt(active.execution);
    emit({
      type: "worker.cancelled",
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      requestId: active.requestId,
      jobId,
    });
  }
}

function safeInterrupt(execution: RemoteCodexExecution): void {
  try { execution.interrupt?.(); }
  catch { /* Cancellation must remain idempotent even if the local adapter already stopped. */ }
}

function boundedProgress(payload: unknown): unknown {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") <= REMOTE_PROGRESS_MAX_BYTES) return payload;
  } catch { /* Replace non-serializable progress with a bounded status event. */ }
  return { kind: "status", label: "Remote progress update omitted because it exceeded the transport limit" };
}

function remoteErrorMessage(error: unknown, fallback: string, localPaths: Array<string | undefined> = []): string {
  let message = error instanceof Error && error.message ? error.message : fallback;
  for (const localPath of localPaths) {
    if (!localPath) continue;
    message = message.split(localPath).join("[local path]");
    if (process.platform === "win32") message = message.toLowerCase().includes(localPath.toLowerCase())
      ? replaceCaseInsensitive(message, localPath, "[local path]")
      : message;
  }
  return message.slice(0, REMOTE_ERROR_MAX_CHARS) || fallback;
}

function replaceCaseInsensitive(value: string, search: string, replacement: string): string {
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(escaped, "gi"), replacement);
}
