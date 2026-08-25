import type { ExecutorTarget } from "./api";

const knownTargets = new Map<string, ExecutorTarget>();

export function rememberExecutorTarget(conversationId: string, target: ExecutorTarget): void {
  knownTargets.set(conversationId, target.kind === "tenant" ? { kind: "tenant" } : { kind: "remote", projectId: target.projectId });
}

export function forgetExecutorTarget(conversationId: string): void {
  knownTargets.delete(conversationId);
}

export function knownExecutorTarget(conversationId: string): ExecutorTarget | undefined {
  return knownTargets.get(conversationId);
}
