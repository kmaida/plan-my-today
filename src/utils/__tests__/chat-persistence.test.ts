/**
 * Tests for chat persistence (sessionStorage save/restore/clear).
 *
 * These test the three functions that allow chat state to survive reauth
 * redirects and page refreshes: saveChatState, restoreChatState, and
 * clearPersistedChatState.
 *
 * Key behaviors verified:
 * - Round-trip save → restore returns equivalent data
 * - Thinking blocks are stripped from assistant history before saving
 * - Non-assistant messages and string-content messages pass through unmodified
 * - restoreChatState returns null for missing, malformed, or invalid data
 * - clearPersistedChatState removes the persisted key
 * - QuotaExceededError in sessionStorage is silently swallowed
 */

import {
  clearPersistedChatState,
  restoreChatState,
  saveChatState,
} from "../../../ui/src/chat/chat-persistence";
import type { ChatMessage, Message, SessionUsage } from "../../../ui/src/chat/types";

// ── Test fixtures ──────────────────────────────────────────────────────────────

const CHAT_STATE_KEY = "chat_state";

const sampleUsage: SessionUsage = {
  totalInputTokens: 1000,
  totalOutputTokens: 500,
  totalCacheCreationTokens: 200,
  totalCacheReadTokens: 800,
};

const sampleMessages: ChatMessage[] = [
  { id: "u1", role: "user", text: "Plan my day", timestamp: 1000 },
  {
    id: "a1",
    role: "assistant",
    text: "Here is your plan.",
    timestamp: 2000,
    toolCalls: [{ id: "tc1", name: "list-all-tasks-today", input: {}, result: '{"calendar":[]}' }],
    usage: { input_tokens: 500, output_tokens: 200 },
  },
];

/** History with a thinking block that should be stripped on save. */
const sampleHistory: Message[] = [
  { role: "user", content: "Plan my day" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me analyze the user's calendar..." },
      { type: "text", text: "Here is your plan." },
      { type: "tool_use", id: "tc1", name: "list-all-tasks-today", input: {} },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tc1", content: '{"calendar":[]}' }],
  },
];

// ── Mock sessionStorage ────────────────────────────────────────────────────────

const store: Record<string, string> = {};

beforeEach(() => {
  // Clear our mock store before each test
  for (const key of Object.keys(store)) delete store[key];

  Object.defineProperty(globalThis, "sessionStorage", {
    value: {
      getItem: jest.fn((key: string) => store[key] ?? null),
      setItem: jest.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: jest.fn((key: string) => {
        delete store[key];
      }),
    },
    writable: true,
    configurable: true,
  });
});

// ── saveChatState + restoreChatState round-trip ────────────────────────────────

describe("saveChatState + restoreChatState", () => {
  it("should round-trip messages, usage, and savedAt", () => {
    saveChatState(sampleMessages, sampleHistory, sampleUsage);

    const restored = restoreChatState();
    expect(restored).not.toBeNull();
    expect(restored!.messages).toEqual(sampleMessages);
    expect(restored!.sessionUsage).toEqual(sampleUsage);
    expect(typeof restored!.savedAt).toBe("number");
  });

  it("should strip thinking blocks from assistant history", () => {
    saveChatState(sampleMessages, sampleHistory, sampleUsage);

    const restored = restoreChatState();
    expect(restored).not.toBeNull();

    // Find the assistant message in restored history
    const assistantMsg = restored!.history.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(Array.isArray(assistantMsg!.content)).toBe(true);

    const blocks = assistantMsg!.content as Array<{ type: string }>;
    const thinkingBlocks = blocks.filter((b) => b.type === "thinking");
    expect(thinkingBlocks).toHaveLength(0);

    // Non-thinking blocks should be preserved
    const textBlocks = blocks.filter((b) => b.type === "text");
    expect(textBlocks).toHaveLength(1);
    const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
    expect(toolUseBlocks).toHaveLength(1);
  });

  it("should preserve user messages with string content unchanged", () => {
    saveChatState(sampleMessages, sampleHistory, sampleUsage);

    const restored = restoreChatState();
    const userMsg = restored!.history.find(
      (m) => m.role === "user" && typeof m.content === "string"
    );
    expect(userMsg).toEqual({ role: "user", content: "Plan my day" });
  });

  it("should preserve user messages with ContentBlock[] content unchanged", () => {
    saveChatState(sampleMessages, sampleHistory, sampleUsage);

    const restored = restoreChatState();
    // The tool_result message
    const toolResultMsg = restored!.history.find(
      (m) => m.role === "user" && Array.isArray(m.content)
    );
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.content).toEqual([
      { type: "tool_result", tool_use_id: "tc1", content: '{"calendar":[]}' },
    ]);
  });

  it("should preserve assistant messages with string content unchanged", () => {
    const historyWithStringAssistant: Message[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello! How can I help?" },
    ];

    saveChatState(sampleMessages, historyWithStringAssistant, sampleUsage);

    const restored = restoreChatState();
    const assistantMsg = restored!.history.find((m) => m.role === "assistant");
    expect(assistantMsg).toEqual({
      role: "assistant",
      content: "Hello! How can I help?",
    });
  });
});

// ── pendingApproval strip on rehydration ───────────────────────────────────────

describe("restoreChatState — pendingApproval strip", () => {
  it("strips pendingApproval from messages on restore", () => {
    // Simulate a persisted message with a pendingApproval field. The resolve
    // callback would have been dropped silently by JSON.stringify; what
    // survives in sessionStorage is the data-only fragment. Restoring it as-
    // is would render a permanently-stuck approval card (buttons would call
    // an undefined resolve), so the restore path must scrub it.
    const persisted = {
      messages: [
        {
          id: "a1",
          role: "assistant",
          text: "About to delegate…",
          timestamp: 2000,
          pendingApproval: { toolInput: { task: "assess SREcon" } },
        },
      ],
      history: [],
      sessionUsage: sampleUsage,
      savedAt: Date.now(),
    };
    store[CHAT_STATE_KEY] = JSON.stringify(persisted);

    const restored = restoreChatState();
    expect(restored).not.toBeNull();
    expect(restored!.messages[0].pendingApproval).toBeUndefined();
  });

  it("also clears isStreaming when stripping pendingApproval", () => {
    // The strip path covers both fields in one map; verify they're cleaned up
    // together so a message that was both streaming and pending doesn't keep
    // either stale flag.
    const persisted = {
      messages: [
        {
          id: "a1",
          role: "assistant",
          text: "Mid-stream when persisted",
          timestamp: 2000,
          isStreaming: true,
          pendingApproval: { toolInput: { task: "X" } },
        },
      ],
      history: [],
      sessionUsage: sampleUsage,
      savedAt: Date.now(),
    };
    store[CHAT_STATE_KEY] = JSON.stringify(persisted);

    const restored = restoreChatState();
    expect(restored!.messages[0].isStreaming).toBe(false);
    expect(restored!.messages[0].pendingApproval).toBeUndefined();
  });

  it("leaves messages without pendingApproval untouched", () => {
    saveChatState(sampleMessages, sampleHistory, sampleUsage);
    const restored = restoreChatState();
    expect(restored!.messages).toEqual(sampleMessages);
  });
});

// ── restoreChatState validation ────────────────────────────────────────────────

describe("restoreChatState", () => {
  it("should return null when sessionStorage is empty", () => {
    expect(restoreChatState()).toBeNull();
  });

  it("should return null for invalid JSON", () => {
    store[CHAT_STATE_KEY] = "not valid json{{{";
    expect(restoreChatState()).toBeNull();
  });

  it("should return null when messages is not an array", () => {
    store[CHAT_STATE_KEY] = JSON.stringify({
      messages: "not an array",
      history: [],
      sessionUsage: sampleUsage,
      savedAt: Date.now(),
    });
    expect(restoreChatState()).toBeNull();
  });

  it("should return null when history is not an array", () => {
    store[CHAT_STATE_KEY] = JSON.stringify({
      messages: [],
      history: "not an array",
      sessionUsage: sampleUsage,
      savedAt: Date.now(),
    });
    expect(restoreChatState()).toBeNull();
  });

  it("should return null when data is a non-object JSON value", () => {
    store[CHAT_STATE_KEY] = JSON.stringify(42);
    expect(restoreChatState()).toBeNull();
  });
});

// ── clearPersistedChatState ────────────────────────────────────────────────────

describe("clearPersistedChatState", () => {
  it("should remove the persisted chat state key", () => {
    saveChatState(sampleMessages, sampleHistory, sampleUsage);
    expect(restoreChatState()).not.toBeNull();

    clearPersistedChatState();
    expect(restoreChatState()).toBeNull();
  });

  it("should not throw when sessionStorage has no chat state", () => {
    expect(() => clearPersistedChatState()).not.toThrow();
  });
});

// ── Error handling ─────────────────────────────────────────────────────────────

describe("error handling", () => {
  it("should silently swallow QuotaExceededError on save", () => {
    (sessionStorage.setItem as jest.Mock).mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    // Should not throw
    expect(() => saveChatState(sampleMessages, sampleHistory, sampleUsage)).not.toThrow();
  });

  it("should return null when sessionStorage.getItem throws", () => {
    (sessionStorage.getItem as jest.Mock).mockImplementation(() => {
      throw new Error("sessionStorage unavailable");
    });

    expect(restoreChatState()).toBeNull();
  });

  it("should not throw when sessionStorage.removeItem throws", () => {
    (sessionStorage.removeItem as jest.Mock).mockImplementation(() => {
      throw new Error("sessionStorage unavailable");
    });

    expect(() => clearPersistedChatState()).not.toThrow();
  });
});
