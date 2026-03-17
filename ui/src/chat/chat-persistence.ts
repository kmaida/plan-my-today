import type { ChatMessage, Message, SessionUsage } from "./types";

const CHAT_STATE_KEY = "chat_state";

interface PersistedChatState {
  messages: ChatMessage[];
  history: Message[];
  sessionUsage: SessionUsage;
  savedAt: number;
}

/**
 * Save chat state to sessionStorage so it survives reauth redirects and page
 * refreshes within the same tab. Thinking blocks are stripped from the Anthropic
 * history before saving — they're bulky, stale after a redirect, and the server's
 * `clear_thinking` context management strategy would discard old ones anyway.
 *
 * Silently swallows errors (QuotaExceededError, serialization failures).
 * The chat works fine without persistence; this is a best-effort enhancement.
 */
export function saveChatState(
  messages: ChatMessage[],
  history: Message[],
  sessionUsage: SessionUsage
): void {
  try {
    // Strip thinking blocks from assistant turns — they're the bulkiest content
    // and not needed for conversation continuity (Claude generates fresh thinking
    // each turn, and the server's clear_thinking strategy discards old ones).
    const slimHistory = history.map((msg) => {
      if (msg.role !== "assistant" || typeof msg.content === "string") return msg;
      return {
        ...msg,
        content: msg.content.filter((b) => b.type !== "thinking"),
      };
    });

    const state: PersistedChatState = {
      messages,
      history: slimHistory,
      sessionUsage,
      savedAt: Date.now(),
    };
    sessionStorage.setItem(CHAT_STATE_KEY, JSON.stringify(state));
  } catch {
    // QuotaExceededError or serialization failure — silently degrade.
    // User just loses chat state on next redirect, same as before this feature.
  }
}

/**
 * Restore chat state from sessionStorage.
 * Returns null if no saved state exists or deserialization fails.
 */
export function restoreChatState(): PersistedChatState | null {
  try {
    const raw = sessionStorage.getItem(CHAT_STATE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as PersistedChatState;
    // Basic shape validation — both must be arrays
    if (!Array.isArray(state.messages) || !Array.isArray(state.history)) {
      return null;
    }
    // Restored messages are never actively streaming — force isStreaming off
    // so stale streaming state doesn't block markdown rendering.
    state.messages = state.messages.map((m) =>
      m.isStreaming ? { ...m, isStreaming: false } : m
    );
    return state;
  } catch {
    return null;
  }
}

/**
 * Remove persisted chat state from sessionStorage.
 * Called on explicit "Clear" and on logout.
 */
export function clearPersistedChatState(): void {
  try {
    sessionStorage.removeItem(CHAT_STATE_KEY);
  } catch {
    // sessionStorage unavailable — nothing to clear
  }
}
