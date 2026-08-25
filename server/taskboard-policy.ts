export const TASKBOARD_STATUSES = ["backlog", "ready", "running", "review", "blocked", "done", "cancelled"] as const;
export type TaskboardStatus = typeof TASKBOARD_STATUSES[number];

export const TASKBOARD_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type TaskboardPriority = typeof TASKBOARD_PRIORITIES[number];

export const TASKBOARD_RISKS = ["low", "medium", "high"] as const;
export type TaskboardRisk = typeof TASKBOARD_RISKS[number];

const ALLOWED_TRANSITIONS: Record<TaskboardStatus, ReadonlySet<TaskboardStatus>> = {
  backlog: new Set(["ready", "cancelled"]),
  ready: new Set(["backlog", "running", "blocked", "cancelled"]),
  running: new Set(["review", "blocked"]),
  review: new Set(["ready", "done", "cancelled"]),
  blocked: new Set(["ready", "cancelled"]),
  done: new Set(),
  cancelled: new Set(),
};

export function isTaskboardStatus(value: unknown): value is TaskboardStatus {
  return typeof value === "string" && (TASKBOARD_STATUSES as readonly string[]).includes(value);
}

export function isTaskboardPriority(value: unknown): value is TaskboardPriority {
  return typeof value === "string" && (TASKBOARD_PRIORITIES as readonly string[]).includes(value);
}

export function isTaskboardRisk(value: unknown): value is TaskboardRisk {
  return typeof value === "string" && (TASKBOARD_RISKS as readonly string[]).includes(value);
}

export function canTransitionTask(from: TaskboardStatus, to: TaskboardStatus): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function transitionTargets(from: TaskboardStatus): TaskboardStatus[] {
  return [...ALLOWED_TRANSITIONS[from]];
}
