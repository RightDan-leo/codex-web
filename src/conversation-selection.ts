export const SELECTED_CONVERSATION_KEY = "codex-web:selected-conversation";
const SELECTION_EVENT = "codex-web:selected-conversation-change";

export function readSelectedConversationId(): string | null {
  try { return window.localStorage.getItem(SELECTED_CONVERSATION_KEY); }
  catch { return null; }
}

export function writeSelectedConversationId(conversationId: string | null): void {
  try {
    if (conversationId) window.localStorage.setItem(SELECTED_CONVERSATION_KEY, conversationId);
    else window.localStorage.removeItem(SELECTED_CONVERSATION_KEY);
  } catch { /* Selection still updates in React when storage is unavailable. */ }
  window.dispatchEvent(new CustomEvent<string | null>(SELECTION_EVENT, { detail: conversationId }));
}

export function subscribeSelectedConversation(listener: (conversationId: string | null) => void): () => void {
  const localListener = (event: Event) => listener((event as CustomEvent<string | null>).detail ?? null);
  const storageListener = (event: StorageEvent) => {
    if (event.key === SELECTED_CONVERSATION_KEY) listener(event.newValue);
  };
  window.addEventListener(SELECTION_EVENT, localListener);
  window.addEventListener("storage", storageListener);
  return () => {
    window.removeEventListener(SELECTION_EVENT, localListener);
    window.removeEventListener("storage", storageListener);
  };
}
