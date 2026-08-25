import {
  REMOTE_WORKER_PROTOCOL_VERSION,
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
};

type PendingCommand = {
  requestId: string;
  jobId: string;
  workerId: string;
  resolve(value: string): void;
  reject(error: Error): void;
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
  private requestSequence = 0;

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
      this.pendingCommands.delete(command.requestId);
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
    };

    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<string>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    const pending: PendingRun = { requestId, jobId: input.jobId, workerId, resolve, reject, callbacks };
    this.pendingByRequest.set(requestId, pending);
    this.pendingByJob.set(input.jobId, pending);

    try {
      session.transport.send(message);
    } catch (error) {
      this.removePending(pending);
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
        this.pendingCommands.set(steerRequestId, {
          requestId: steerRequestId,
          jobId: input.jobId,
          workerId: current.workerId,
          resolve: resolveSteer,
          reject: rejectSteer,
        });
        try {
          activeSession.transport.send(steer);
        } catch (error) {
          this.pendingCommands.delete(steerRequestId);
          rejectSteer(error instanceof Error ? error : new Error(String(error)));
        }
        return accepted;
      },
      interrupt: () => {
        const current = this.pendingByJob.get(input.jobId);
        if (!current) return;
        const activeSession = this.workers.get(current.workerId);
        if (!activeSession) return;
        if (!activeSession.hello.capabilities.supportsInterrupt) return;
        const cancel: ServerCancelMessage = {
          type: "server.cancel",
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          requestId: this.nextRequestId(input.jobId),
          jobId: input.jobId,
        };
        activeSession.transport.send(cancel);
      },
    };
  }

  receive(workerId: string, rawMessage: unknown): void {
    const session = this.workers.get(workerId);
    if (!session) throw new Error(`Unknown remote worker: ${workerId}`);
    const message: WorkerToServerMessage = validateWorkerMessage(rawMessage);
    if (message.type === "worker.ready" || message.type === "worker.pong") return;

    const command = this.pendingCommands.get(message.requestId);
    if (command) {
      if (command.workerId !== workerId) throw new Error("Remote worker attempted to answer another worker's command");
      if (message.type === "worker.steered") {
        this.pendingCommands.delete(command.requestId);
        command.resolve(message.turnId || `remote:${command.jobId}:${command.requestId}`);
      } else if (message.type === "worker.error") {
        this.pendingCommands.delete(command.requestId);
        command.reject(new Error(message.message));
      }
      return;
    }

    const pending = this.pendingByRequest.get(message.requestId);
    if (!pending) return;
    if (pending.workerId !== workerId) throw new Error("Remote worker attempted to answer another worker's request");

    switch (message.type) {
      case "worker.thread.started":
        pending.callbacks.onThreadStarted?.(message.threadId);
        return;
      case "worker.progress":
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
      this.pendingCommands.delete(command.requestId);
      command.reject(new Error("Remote job is no longer running"));
    }
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
