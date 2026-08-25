import {
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

    let execution: RemoteCodexExecution;
    try {
      execution = this.startCodex({
        jobId: message.jobId,
        cwd: project.cwd,
        ...(project.codexHome ? { codexHome: project.codexHome } : {}),
        ...(message.codexThreadId ? { threadId: message.codexThreadId } : {}),
        prompt: message.prompt,
        ...(message.model ? { model: message.model } : {}),
        ...(message.reasoningEffort ? { reasoningEffort: message.reasoningEffort } : {}),
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
          payload,
        }),
      });
    } catch (error) {
      emit({
        type: "worker.error",
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        requestId: message.requestId,
        jobId: message.jobId,
        message: error instanceof Error ? error.message : "Unable to start remote Codex",
      });
      return;
    }

    this.activeRuns.set(message.jobId, { requestId: message.requestId, execution });
    try {
      const result = await execution.result;
      emit({
        type: "worker.result",
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        requestId: message.requestId,
        jobId: message.jobId,
        result,
      });
    } catch (error) {
      emit({
        type: "worker.error",
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        requestId: message.requestId,
        jobId: message.jobId,
        message: error instanceof Error ? error.message : "Remote Codex failed",
      });
    } finally {
      this.activeRuns.delete(message.jobId);
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
      await active.execution.steer(prompt);
    } catch (error) {
      emit({
        type: "worker.error",
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        requestId,
        jobId,
        message: error instanceof Error ? error.message : "Unable to steer remote Codex",
      });
    }
  }

  private cancel(jobId: string, requestId: string, emit: WorkerEmit): void {
    const active = this.activeRuns.get(jobId);
    if (!active) return;
    active.execution.interrupt?.();
    emit({
      type: "worker.cancelled",
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      requestId: active.requestId,
      jobId,
    });
    this.activeRuns.delete(jobId);
  }
}
