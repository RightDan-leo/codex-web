export type ExecutorChangeState = {
  hasThread: boolean;
  messageCount: number;
  activeJobCount: number;
  queuedPromptCount: number;
  editingPromptCount: number;
  draftFileCount: number;
};

export function canChangeExecutor(state: ExecutorChangeState): boolean {
  return !state.hasThread
    && state.messageCount === 0
    && state.activeJobCount === 0
    && state.queuedPromptCount === 0
    && state.editingPromptCount === 0
    && state.draftFileCount === 0;
}
