export type ExecutorTarget =
  | { kind: "tenant" }
  | { kind: "remote"; projectId: string };

export type RoutedTurnInput = {
  jobId: string;
  prompt: string;
  codexThreadId?: string;
  model?: string;
  reasoningEffort?: string;
};

export type RoutedTurnCallbacks = {
  onThreadStarted?(threadId: string): void;
  onProgress?(payload: unknown): void;
};

export type RoutedTurnExecution = {
  result: Promise<string>;
  steer(prompt: string): Promise<unknown> | unknown;
  interrupt(): void;
};

export type TenantExecutor = (
  input: RoutedTurnInput,
  callbacks: RoutedTurnCallbacks,
) => RoutedTurnExecution;

export type RemoteExecutor = (
  input: RoutedTurnInput & { projectId: string },
  callbacks: RoutedTurnCallbacks,
) => RoutedTurnExecution;

/**
 * Small routing seam between the existing tenant worker and future trusted
 * executors. Keeping the target explicit prevents a normal web request from
 * silently turning into host/remote filesystem access.
 */
export class ExecutorRouter {
  constructor(
    private readonly tenantExecutor: TenantExecutor,
    private readonly remoteExecutor?: RemoteExecutor,
  ) {}

  start(target: ExecutorTarget, input: RoutedTurnInput, callbacks: RoutedTurnCallbacks = {}): RoutedTurnExecution {
    if (target.kind === "tenant") return this.tenantExecutor(input, callbacks);
    if (!this.remoteExecutor) throw new Error("Remote execution is not configured");
    return this.remoteExecutor({ ...input, projectId: target.projectId }, callbacks);
  }
}
