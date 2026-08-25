import crypto from "node:crypto";
import type { ServerToWorkerMessage, WorkerHelloMessage } from "./remote-worker-protocol.js";
import { validateWorkerHello } from "./remote-worker-protocol.js";
import { RemoteWorkerGateway, type RemoteWorkerStatus } from "./remote-worker-gateway.js";

type PendingPoll = {
  resolve(message: ServerToWorkerMessage | null): void;
  timer: NodeJS.Timeout;
};

type PollingSession = {
  id: string;
  workerId: string;
  hello: WorkerHelloMessage;
  queue: ServerToWorkerMessage[];
  waiter?: PendingPoll;
  lastSeenAt: number;
};

export type RemoteWorkerPollingOptions = {
  maxQueuedMessages?: number;
  pollTimeoutMs?: number;
  sessionTtlMs?: number;
  now?: () => number;
};

export class RemoteWorkerPollingHub {
  private readonly sessions = new Map<string, PollingSession>();
  private readonly sessionByWorker = new Map<string, string>();
  private readonly maxQueuedMessages: number;
  private readonly pollTimeoutMs: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;

  constructor(
    readonly gateway: RemoteWorkerGateway,
    options: RemoteWorkerPollingOptions = {},
  ) {
    this.maxQueuedMessages = options.maxQueuedMessages ?? 128;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 25_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 90_000;
    this.now = options.now ?? Date.now;
  }

  register(rawHello: unknown): { sessionId: string; worker: RemoteWorkerStatus } {
    const hello = validateWorkerHello(rawHello);
    const previousSessionId = this.sessionByWorker.get(hello.workerId);
    if (previousSessionId) this.close(previousSessionId, "remote worker reconnected");

    const sessionId = crypto.randomUUID();
    const session: PollingSession = {
      id: sessionId,
      workerId: hello.workerId,
      hello,
      queue: [],
      lastSeenAt: this.now(),
    };
    this.sessions.set(sessionId, session);
    this.sessionByWorker.set(hello.workerId, sessionId);
    try {
      const worker = this.gateway.attach(hello, {
        send: (message) => this.enqueue(sessionId, message),
        close: (reason) => this.close(sessionId, reason || "remote worker transport closed"),
      });
      return { sessionId, worker };
    } catch (error) {
      this.sessions.delete(sessionId);
      if (this.sessionByWorker.get(hello.workerId) === sessionId) this.sessionByWorker.delete(hello.workerId);
      throw error;
    }
  }

  poll(sessionId: string, timeoutMs = this.pollTimeoutMs): Promise<ServerToWorkerMessage | null> {
    const session = this.requireSession(sessionId);
    session.lastSeenAt = this.now();
    const queued = session.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (session.waiter) throw new Error("Remote worker already has an active poll request");

    const boundedTimeout = Math.max(1_000, Math.min(timeoutMs, this.sessionTtlMs));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (session.waiter?.timer !== timer) return;
        session.waiter = undefined;
        session.lastSeenAt = this.now();
        resolve(null);
      }, boundedTimeout);
      timer.unref?.();
      session.waiter = { resolve, timer };
    });
  }

  receive(sessionId: string, rawMessage: unknown): void {
    const session = this.requireSession(sessionId);
    session.lastSeenAt = this.now();
    this.gateway.receive(session.workerId, rawMessage);
  }

  close(sessionId: string, reason = "remote worker polling session closed"): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (this.sessionByWorker.get(session.workerId) === sessionId) this.sessionByWorker.delete(session.workerId);
    if (session.waiter) {
      clearTimeout(session.waiter.timer);
      session.waiter.resolve(null);
      session.waiter = undefined;
    }
    this.gateway.detach(session.workerId, reason);
  }

  closeAll(reason = "remote worker polling service closed"): void {
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId, reason);
  }

  sweepIdle(): number {
    const deadline = this.now() - this.sessionTtlMs;
    let removed = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.lastSeenAt > deadline) continue;
      this.close(session.id, "remote worker polling session expired");
      removed += 1;
    }
    return removed;
  }

  private enqueue(sessionId: string, message: ServerToWorkerMessage): void {
    const session = this.requireSession(sessionId);
    if (session.waiter) {
      const waiter = session.waiter;
      session.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    if (session.queue.length >= this.maxQueuedMessages) {
      this.close(sessionId, "remote worker outbound queue overflow");
      throw new Error("Remote worker outbound queue overflow");
    }
    session.queue.push(message);
  }

  private requireSession(sessionId: string): PollingSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown remote worker polling session");
    return session;
  }
}
