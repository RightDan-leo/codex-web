import type { ExecutorTarget, RemoteWorkerStatus } from "./api";

export type ExecutorOption = {
  value: string;
  label: string;
  description: string;
  target: ExecutorTarget;
  online: boolean;
};

const REMOTE_PREFIX = "remote:";

export function executorValue(target: ExecutorTarget): string {
  return target.kind === "tenant" ? "tenant" : `${REMOTE_PREFIX}${target.projectId}`;
}

export function parseExecutorValue(value: string): ExecutorTarget | null {
  if (value === "tenant") return { kind: "tenant" };
  if (!value.startsWith(REMOTE_PREFIX)) return null;
  const projectId = value.slice(REMOTE_PREFIX.length);
  return projectId ? { kind: "remote", projectId } : null;
}

export function executorIsOnline(target: ExecutorTarget, workers: RemoteWorkerStatus[]): boolean {
  return target.kind === "tenant" || workers.some((worker) => worker.projects.some((project) => project.id === target.projectId));
}

export function buildExecutorOptions(
  workers: RemoteWorkerStatus[],
  selected: ExecutorTarget,
): ExecutorOption[] {
  const options: ExecutorOption[] = [{
    value: "tenant",
    label: "隔离工作区",
    description: "在 Codex Web 的受限容器中执行",
    target: { kind: "tenant" },
    online: true,
  }];
  const seen = new Set<string>();
  const orderedWorkers = [...workers].sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
  for (const worker of orderedWorkers) {
    const projects = [...worker.projects].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      seen.add(project.id);
      options.push({
        value: `${REMOTE_PREFIX}${project.id}`,
        label: project.name,
        description: `${worker.displayName} · 远端项目在线`,
        target: { kind: "remote", projectId: project.id },
        online: true,
      });
    }
  }
  if (selected.kind === "remote" && !seen.has(selected.projectId)) {
    options.push({
      value: `${REMOTE_PREFIX}${selected.projectId}`,
      label: selected.projectId,
      description: "已选择的远端项目当前离线",
      target: selected,
      online: false,
    });
  }
  return options;
}

export function executorSummary(target: ExecutorTarget, workers: RemoteWorkerStatus[]): {
  label: string;
  description: string;
  online: boolean;
} {
  if (target.kind === "tenant") {
    return { label: "隔离工作区", description: "服务器容器", online: true };
  }
  for (const worker of workers) {
    const project = worker.projects.find((candidate) => candidate.id === target.projectId);
    if (project) return { label: project.name, description: worker.displayName, online: true };
  }
  return { label: target.projectId, description: "远端项目离线", online: false };
}
