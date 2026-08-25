import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_PROGRESS_MAX_EVENTS,
  type RemoteAttachmentPayload,
  type ServerCancelMessage,
  type ServerRunMessage,
  type ServerSteerMessage,
  type ServerToWorkerMessage,
  type WorkerHelloMessage,
  type WorkerToServerMessage,
  validateWorkerHello,
  validateWorkerMessage,
} from "./remote-worker-protocol.js";

export type RemoteWorkerTransport = {
  send(message: ServerToWorkerMessage): void;
  close?(reason?: string): void;
};

export type RemoteRunInput = {
  jobId: string;
  projectId: string;
  prompt: string;
  codexThreadId?: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: RemoteAttachmentPayload[];
};

export type RemoteRunCallbacks = {
  onThreadStarted?(threadId: string): void;
  onProgress?(payload: unknown): void;
};

export type RemoteRunExecution = {
  result: Promise<string>;
  steer(prompt: string): Promise<string>;
  interrupt(): void;
};

type WorkerSession = {
  hello: WorkerHelloMessage;
  transport: RemoteWorkerTransport;
  connectedAt: number;
};

type PendingRun = {
  requestId: string;
  jobId: string;
  workerId: string;
  resolve(value: string): void;
  reject(error: Error): void;
  callbacks: RemoteRunCallbacks;
  progressCount: number;
};

type PendingCommand = {
  requestId: string;
  jobId: string;
  workerId: string;
  resolve(value: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export type RemoteWorkerGatewayOptions = {
  commandTimeoutMs?: number;
};

export type RemoteWorkerStatus = {
  workerId: string;
  displayName: string;
  connectedAt: number;
  projects: Array<{ id: string; name: string }>;
};

export class RemoteWorkerGateway {
  private readonly workers = new Map<string, WorkerSession>();
  private readonly projectOwners = new Map<string, string>();
  private readonly pendingByRequest = new Map<string, PendingRun>();
  private readonly pendingByJob = new Map<string, PendingRun>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly commandTimeoutMs: number;
  private requestSequence = 0;

  constructor(options: RemoteWorkerGatewayOptions = {}) {
    this.commandTimeoutMs = Math.max(10, options.commandTimeoutMs ?? 15_000);
  }

  attach(rawHello: unknown, transport: RemoteWorkerTransport): RemoteWorkerStatus {
    const hello = validateWorkerHello(rawHello);
    const existing = this.workers.get(hello.workerId);
    if (existing) this.detach(hello.workerId, "worker reconnected");

    for (const project of hello.projects) {
      const owner = this.projectOwners.get(project.id);
      if (owner && owner !== hello.workerId) throw new Error(`Remote project id already registered: ${project.id}`);
    }

    const session: WorkerSession = { hello, transport, connectedAt: Date.now() };
    this.workers.set(hello.workerId, session);
    for (const project of hello.projects) this.projectOwners.set(project.id, hello.workerId);
    return this.statusFor(session);
  }

  detach(workerId: string, reason = "remote worker disconnected"): void {
    const session = this.workers.get(workerId);
    if (!session) return;
    this.workers.delete(workerId);
    for (const project of session.hello.projects) {
      if (this.projectOwners.get(project.id) === workerId) this.projectOwners.delete(project.id);
    }
    for (const pending of [...this.pendingByRequest.values()]) {
      if (pending.workerId !== workerId) continue;
      this.removePending(pending);
      pending.reject(new Error(reason));
    }
    for (const command of [...this.pendingCommands.values()]) {
      if (command.workerId !== workerId) continue;
      this.removeCommand(command);
      command.reject(new Error(reason));
    }
  }

  listWorkers(): RemoteWorkerStatus[] {
    return [...this.workers.values()].map((session) => this.statusFor(session));
  }

  hasProject(projectId: string): boolean {
    return this.projectOwners.has(projectId);
  }

  start(input: RemoteRunInput, callbacks: RemoteRunCallbacks = {}): RemoteRunExecution {
    if (this.pendingByJob.has(input.jobId)) throw new Error(`Remote job is already running: ${input.jobId}`);
    const workerId = this.projectOwners.get(input.projectId);
    if (!workerId) throw new Error(`No online remote worker provides project: ${input.projectId}`);
    const session = this.workers.get(workerId);
    if (!session) throw new Error(`Remote worker is offline: ${workerId}`);
    const attachments = input.attachments ?? [];
    if (attachments.length > 0 && session.hello.capabilities.supportsAttachments !== true) {
      throw new Error("Remote worker does not support attachment staging; update and restart the worker");
    }

    const requestId = this.nextRequestId(input.jobId);
    const message: ServerRunMessage = {
      type: "server.run",
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      requestId,
      jobId: input.jobId,
      projectId: input.projectId,
      prompt: input.prompt,
      ...(input.codexThreadId ? { codexThreadId: input.codexThreadId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<string>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    const pending: PendingRun = { requestId, jobId: input.jobId, workerId, resolve, reject, callbacks, progressCount: 0 };
    this.pendingByRequest.set(requestId, pending);
    this.pendingByJob.set(input.jobId, pending);

    try {
      session.transport.send(message);
    } catch (error) {
      this.removePending(pending);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      void result.catch(() => undefined);
      throw error;
    }

    return {
      result,
      steer: (prompt: string) => {
        const current = this.pendingByJob.get(input.jobId);
        if (!current) return Promise.reject(new Error("Remote job is no longer running"));
        const activeSession = this.workers.get(current.workerId);
        if (!activeSession) return Promise.reject(new Error("Remote worker is offline"));
        if (!activeSession.hello.capabilities.supportsSteering) return Promise.reject(new Error("Remote worker does not support steering"));
        const steerRequestId = this.nextRequestId(input.jobId);
        const steer: ServerSteerMessage = {
          type: "server.steer",
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          requestId: steerRequestId,
          jobId: input.jobId,
          prompt,
        };
        let resolveSteer!: (value: string) => void;
        let rejectSteer!: (error: Error) => void;
        const accepted = new Promise<string>((resolveCommand, rejectCommand) => {
          resolveSteer = resolveCommand;
          rejectSteer = rejectCommand;
        });
        const timer = setTimeout(() => {
          const command = this.pendingCommands.get(steerRequestId);
          if (!command) return;
          this.removeCommand(command);
          command.reject(new Error("Remote steering acknowledgement timed out"));
        }, this.commandTimeoutMs);
        timer.unref?.();
        const command: PendingCommand = {
          requestId: steerRequestId,
          jobId: input.jobId,
          workerId: current.workerId,
          resolve: resolveSteer,
          reject: rejectSteer,
          timer,
        };
        this.pendingCommands.set(steerRequestId, command);
        try {
          activeSession.transport.send(steer);
        } catch (error) {
          this.removeCommand(command);
          rejectSteer(error instanceof Error ? error : new Error(String(error)));
        }
        return accepted;
      },
      interrupt: () => {
        const current = this.pendingByJob.get(input.jobId);
        if (!current) return;
        this.removePending(current);
        const cancelled = new Error("Remote job was cancelled");
        cancelled.name = "AbortError";
        current.reject(cancelled);
        const activeSession = this.workers.get(current.workerId);
        if (!activeSession) return;
        if (!activeSession.hello.capabilities.supportsInterrupt) return;
        const cancel: ServerCancelMessage = {
          type: "server.cancel",
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          requestId: this.nextRequestId(input.jobId),
          jobId: input.jobId,
        };
        try { activeSession.transport.send(cancel); }
        catch { /* Cancellation is already final locally; transport is best effort. */ }
      },
    };
  }

  receive(workerId: string, rawMessage: unknown): void {
    const session = this.workers.get(workerId);
    if (!session) throw new Error(`Unknown remote worker: ${workerId}`);
    const message: WorkerToServerMessage = validateWorkerMessage(rawMessage);
    if (message.type === "worker.ready") {
      if (message.workerId !== workerId) throw new Error("Remote worker ready identity does not match its session");
      return;
    }
    if (message.type === "worker.pong") return;

    const command = this.pendingCommands.get(message.requestId);
    if (command) {
      if (command.workerId !== workerId) throw new Error("Remote worker attempted to answer another worker's command");
      if (!("jobId" in message) || message.jobId !== command.jobId) throw new Error("Remote worker command job id does not match its request");
      if (message.type === "worker.steered") {
        this.removeCommand(command);
        command.resolve(message.turnId || `remote:${command.jobId}:${command.requestId}`);
      } else if (message.type === "worker.error") {
        this.removeCommand(command);
        command.reject(new Error(message.message));
      }
      return;
    }

    const pending = this.pendingByRequest.get(message.requestId);
    if (!pending) return;
    if (pending.workerId !== workerId) throw new Error("Remote worker attempted to answer another worker's request");
    if (!("jobId" in message) || message.jobId !== pending.jobId) throw new Error("Remote worker job id does not match its request");

    switch (message.type) {
      case "worker.thread.started":
        pending.callbacks.onThreadStarted?.(message.threadId);
        return;
      case "worker.progress":
        pending.progressCount += 1;
        if (pending.progressCount > REMOTE_PROGRESS_MAX_EVENTS) {
          this.removePending(pending);
          pending.reject(new Error("Remote worker sent too many progress updates"));
          return;
        }
        pending.callbacks.onProgress?.(message.payload);
        return;
      case "worker.result":
        this.removePending(pending);
        pending.resolve(message.result);
        return;
      case "worker.error":
        this.removePending(pending);
        pending.reject(new Error(message.message));
        return;
      case "worker.cancelled":
        this.removePending(pending);
        pending.reject(new Error("Remote job was cancelled"));
        return;
      case "worker.steered":
        return;
    }
  }

  private removePending(pending: PendingRun): void {
    this.pendingByRequest.delete(pending.requestId);
    if (this.pendingByJob.get(pending.jobId) === pending) this.pendingByJob.delete(pending.jobId);
    for (const command of [...this.pendingCommands.values()]) {
      if (command.jobId !== pending.jobId) continue;
      this.removeCommand(command);
      command.reject(new Error("Remote job is no longer running"));
    }
  }

  private removeCommand(command: PendingCommand): void {
    if (this.pendingCommands.get(command.requestId) !== command) return;
    this.pendingCommands.delete(command.requestId);
    clearTimeout(command.timer);
  }

  private nextRequestId(jobId: string): string {
    this.requestSequence = (this.requestSequence + 1) % Number.MAX_SAFE_INTEGER;
    return `${jobId}:${this.requestSequence}`;
  }

  private statusFor(session: WorkerSession): RemoteWorkerStatus {
    return {
      workerId: session.hello.workerId,
      displayName: session.hello.displayName,
      connectedAt: session.connectedAt,
      projects: session.hello.projects.map((project) => ({ ...project })),
    };
  }
}
