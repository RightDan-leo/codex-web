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

export function assertRemoteAttachmentsSupported(conversationId: string, fileCount: number): void {
  if (fileCount <= 0) return;
  if (knownTargets.get(conversationId)?.kind === "remote") {
    throw new Error("远端项目暂不支持网页附件；请移除附件，或切回隔离工作区后再上传。");
  }
}
