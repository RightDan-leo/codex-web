import type { ExecutorTarget, RemoteWorkerStatus, TaskboardStatus, TaskboardTask } from "./api";

const STATUS_LABELS: Record<TaskboardStatus, string> = {
  backlog: "待规划",
  ready: "待开发",
  running: "开发中",
  review: "待验收",
  blocked: "已阻塞",
  done: "已完成",
  cancelled: "已取消",
};

export function executorOnline(target: ExecutorTarget, workers: RemoteWorkerStatus[]): boolean {
  return target.kind === "tenant" || workers.some((worker) => worker.projects.some((project) => project.id === target.projectId));
}

export function transitionLabel(from: TaskboardStatus, to: TaskboardStatus): string {
  if (from === "review" && to === "done") return "验收通过";
  if (from === "review" && to === "ready") return "驳回重做";
  if (to === "running") return "开始开发";
  if (to === "review") return "提交验收";
  if (to === "blocked") return "标记阻塞";
  if (to === "cancelled") return "取消任务";
  if (to === "ready") return "移至待开发";
  if (to === "backlog") return "退回待规划";
  return STATUS_LABELS[to];
}

export function taskDraft(task: TaskboardTask): string {
  const lines = [
    `执行智能看板任务：${task.title}`,
    task.description ? `\n任务说明：\n${task.description}` : "",
    task.acceptanceCriteria ? `\n验收标准：\n${task.acceptanceCriteria}` : "",
    "\n请在当前项目内完成任务，运行必要验证，并在结束时总结修改和测试结果。不要自行把任务标记为验收通过。",
  ];
  return lines.filter(Boolean).join("\n");
}
