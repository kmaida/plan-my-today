import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../config";
import { useMCP } from "../mcp";
import { clearPersistedChatState, restoreChatState, saveChatState } from "./chat-persistence";
import { createStreamParseState, processSseLine, toAnthropicResponse } from "./sse-parser";
import type { SystemPromptParts } from "./system-prompt";
import { evaluateToolRound, type ToolRoundResult } from "./tool-round-utils";
import type {
  AnthropicResponse,
  ChatMessage,
  ContentBlock,
  Message,
  SessionUsage,
  ToolCall,
  ToolDefinition,
} from "./types";

/** A tool_use content block (extracted from the ContentBlock union). */
type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

const MAX_TOOL_ROUNDS = 10; // Safety limit to prevent infinite loops

/**
 * Infer an effort level from the user's message to pass to the Anthropic API.
 * High effort (default) for complex planning; low effort for quick actions
 * like marking tasks complete. The server only applies this for supported models.
 */
type EffortLevel = "high" | "medium" | "low";

function inferEffort(text: string): EffortLevel {
  const lower = text.toLowerCase();

  // Quick actions: imperative "mark X done/complete", dismiss, undo.
  // Uses multi-word patterns to avoid false positives on common words
  // like "done" in "what have I done today?"
  if (/\b(mark\b.*\b(done|complete)|dismiss|undo)\b/.test(lower)) return "low";

  // Complex planning: plan my day, prioritize, analyze, summarize
  if (/\b(plan|prioritize|analyze|summarize|brief|review|what.*today|damage report)\b/.test(lower))
    return "high";

  return "medium";
}

/** Convert MCP tool schemas to Anthropic tool format. */
function toAnthropicTools(
  mcpTools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
): ToolDefinition[] {
  return mcpTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema ?? { type: "object", properties: {} },
  }));
}

/** Generate a simple unique ID. */
function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Truncate a tool result string to avoid blowing up the Anthropic context window.
 * 30K chars ≈ ~8K tokens — plenty for Claude to summarise while staying well
 * within limits even after multiple tool rounds.
 */
const MAX_TOOL_RESULT_CHARS = 30_000;

function truncateToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[... result truncated due to size ...]`;
}

export type { SessionUsage } from "./types";

export interface UseChatReturn {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  /** Accumulated token usage for the entire chat session. */
  sessionUsage: SessionUsage;
  sendMessage: (text: string) => Promise<void>;
  /** Abort the current in-flight request. Partial streamed text stays visible. */
  cancel: () => void;
  clearMessages: () => void;
}

export function useChat(
  buildSystemPrompt?: () => SystemPromptParts,
  onToolRoundComplete?: (result: ToolRoundResult) => void,
  onFetchStarted?: () => void
): UseChatReturn {
  const { callTool, tools: mcpTools, isConnected } = useMCP();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionUsage, setSessionUsage] = useState<SessionUsage>({
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
  });

  // Keep a ref to the full Anthropic message history (for context continuity)
  const historyRef = useRef<Message[]>([]);
  // AbortController ref so in-flight streams can be cancelled on unmount
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight stream when the component unmounts
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Restore persisted chat state on mount (survives reauth redirects and page refreshes).
  // Guarded by a ref so React 18 strict mode double-firing doesn't restore twice.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const saved = restoreChatState();
    if (saved) {
      setMessages(saved.messages);
      historyRef.current = saved.history;
      setSessionUsage(saved.sessionUsage);
    }
  }, []);

  // Persist chat state after each completed turn. Detects the isLoading true→false
  // transition so we fire once per turn, not on every streaming delta. By the time
  // isLoading flips false, both messages state and historyRef reflect the final turn.
  const prevIsLoadingRef = useRef(false);
  useEffect(() => {
    const wasLoading = prevIsLoadingRef.current;
    prevIsLoadingRef.current = isLoading;
    if (wasLoading && !isLoading && messages.length > 0) {
      saveChatState(messages, historyRef.current, sessionUsage);
    }
  }, [isLoading, messages, sessionUsage]);

  /**
   * Mark a specific assistant message as no longer streaming.
   * This keeps UI state consistent when a request is cancelled or errors.
   */
  const finalizeStreamingMessage = useCallback((messageId: string | null) => {
    if (!messageId) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId && m.role === "assistant" && m.isStreaming
          ? { ...m, isStreaming: false }
          : m
      )
    );
  }, []);

  const sendMessage = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: chat send handler — manages message state, streaming, and tool calls
    async (userText: string) => {
      if (!isConnected) {
        setError("MCP client not connected — sign in first");
        return;
      }

      setError(null);
      setIsLoading(true);

      // Cancel any previous in-flight request
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      // Add user message to UI
      const userMsg: ChatMessage = {
        id: uid(),
        role: "user",
        text: userText,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Add to Anthropic history
      historyRef.current.push({ role: "user", content: userText });

      // Track whether onFetchStarted was called this turn so we can ensure
      // onToolRoundComplete always fires to reset the header animation.
      let fetchStartedThisTurn = false;
      let activeAssistantMsgId: string | null = null;

      try {
        const tools = toAnthropicTools(mcpTools);
        // Compute system prompt once per user message (not per tool round)
        // so the time context stays consistent across rounds.
        const systemParts = buildSystemPrompt?.() ?? null;
        const effort = inferEffort(userText);
        let rounds = 0;

        // Agentic loop: keep going while Claude wants to call tools
        while (rounds < MAX_TOOL_ROUNDS) {
          rounds++;

          // Create a streaming assistant message in the UI
          const msgId = uid();
          activeAssistantMsgId = msgId;
          setMessages((prev) => [
            ...prev,
            { id: msgId, role: "assistant", text: "", isStreaming: true, timestamp: Date.now() },
          ]);

          const onTextDelta = (accumulated: string) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === msgId ? { ...m, text: accumulated } : m))
            );
          };

          const response = await streamChatAPI(
            historyRef.current,
            tools,
            systemParts,
            effort,
            onTextDelta,
            abort.signal
          );

          // Accumulate session-level token usage from this turn
          setSessionUsage((prev) => ({
            totalInputTokens: prev.totalInputTokens + response.usage.input_tokens,
            totalOutputTokens: prev.totalOutputTokens + response.usage.output_tokens,
            totalCacheCreationTokens:
              prev.totalCacheCreationTokens + (response.usage.cache_creation_input_tokens ?? 0),
            totalCacheReadTokens:
              prev.totalCacheReadTokens + (response.usage.cache_read_input_tokens ?? 0),
          }));

          // Extract text and tool_use blocks from the reconstructed response
          const textParts: string[] = [];
          const toolUseBlocks: ToolUseBlock[] = [];

          for (const block of response.content) {
            if (block.type === "text") textParts.push(block.text);
            if (block.type === "tool_use") toolUseBlocks.push(block);
          }

          const fullText = textParts.join("");

          // Add assistant response to history
          historyRef.current.push({ role: "assistant", content: response.content });

          if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
            // Final response — update the streaming message with final text and usage
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId
                  ? { ...m, text: fullText, isStreaming: false, usage: response.usage }
                  : m
              )
            );
            activeAssistantMsgId = null;
            break;
          }

          // Execute tool calls
          const toolCalls: ToolCall[] = [];
          const toolResults: ContentBlock[] = [];

          for (const block of toolUseBlocks) {
            // Signal the header animation before the big API call starts
            if (block.name === "list-all-tasks-today" && onFetchStarted) {
              onFetchStarted();
              fetchStartedThisTurn = true;
            }

            let resultText: string;
            let isError = false;

            try {
              const result = await callTool(block.name, block.input);
              const content = result.content as Array<{ type: string; text?: string }> | undefined;
              const textItem = content?.find((c) => c.type === "text");
              resultText = textItem?.text ?? JSON.stringify(result);
              // Respect the MCP protocol's isError flag from the server
              isError = result.isError === true;
            } catch (err) {
              resultText = err instanceof Error ? err.message : String(err);
              isError = true;
            }

            toolCalls.push({
              id: block.id,
              name: block.name,
              input: block.input,
              result: resultText,
              isError,
            });

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: truncateToolResult(resultText),
              is_error: isError,
            });
          }

          // Notify caller about tool round results (auth errors, task fetches).
          // Fires synchronously at call time — no React effect or timing dependency.
          if (onToolRoundComplete) {
            const roundResult = evaluateToolRound(toolCalls);
            if (roundResult) {
              onToolRoundComplete(roundResult);
              // Normal path handled — clear the flag so the finally-block
              // safety net doesn't fire a redundant notification.
              fetchStartedThisTurn = false;
            }
          }

          // Update the streaming message with tool calls (intermediate turn)
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId ? { ...m, text: fullText, isStreaming: false, toolCalls } : m
            )
          );
          activeAssistantMsgId = null;

          // Add tool results to history so Claude can see them
          historyRef.current.push({ role: "user", content: toolResults });
        }

        if (rounds >= MAX_TOOL_ROUNDS) {
          setError("Reached maximum tool call rounds — stopping to avoid infinite loop");
        }
      } catch (err) {
        // Don't surface abort errors — they're intentional (unmount / new request)
        if (err instanceof DOMException && err.name === "AbortError") {
          finalizeStreamingMessage(activeAssistantMsgId);
          // If we signalled the header animation, send a no-op round result
          // so the caller resets refreshing state.
          if (fetchStartedThisTurn && onToolRoundComplete) {
            onToolRoundComplete({ didFetchAllTasks: false, authErrors: [] });
            fetchStartedThisTurn = false;
          }
          return;
        }
        const msg = err instanceof Error ? err.message : "Chat request failed";
        finalizeStreamingMessage(activeAssistantMsgId);
        setError(msg);
      } finally {
        // If we signalled the header animation but onToolRoundComplete never
        // fired (e.g., non-abort error before tool round finished), ensure
        // the caller still gets notified to reset refreshing state.
        if (fetchStartedThisTurn && onToolRoundComplete) {
          onToolRoundComplete({ didFetchAllTasks: false, authErrors: [] });
        }
        setIsLoading(false);
      }
    },
    [
      isConnected,
      mcpTools,
      callTool,
      buildSystemPrompt,
      onToolRoundComplete,
      onFetchStarted,
      finalizeStreamingMessage,
    ]
  );

  /** Cancel the in-flight stream. Partial text stays in the chat (it's already
   *  committed to React state). The existing catch block handles AbortError silently. */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Clear streaming flags before isLoading, so the persistence save
    // (triggered by the isLoading true→false transition) captures final state.
    setMessages((prev) => prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)));
    setIsLoading(false);
  }, []);

  const clearMessages = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    historyRef.current = [];
    setError(null);
    setSessionUsage({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    });
    clearPersistedChatState();
  }, []);

  return { messages, isLoading, error, sessionUsage, sendMessage, cancel, clearMessages };
}

// ── Streaming API call ───────────────────────────────────────────────────────

/**
 * Stream a chat request from the Anthropic API via our server proxy.
 * Calls `onText` with the accumulated text as each delta arrives (for real-time UI).
 * Returns the reconstructed AnthropicResponse so the agentic loop logic stays unchanged.
 */
export async function streamChatAPI(
  messages: Message[],
  tools: ToolDefinition[],
  systemParts: SystemPromptParts | null,
  effort: EffortLevel,
  onText: (text: string) => void,
  signal?: AbortSignal
): Promise<AnthropicResponse> {
  const body: Record<string, unknown> = { messages, effort };
  // Send the system prompt as two content blocks so the server can cache
  // the static block independently of the time-varying dynamic block.
  if (systemParts) {
    body.system = [
      { type: "text", text: systemParts.staticPrompt },
      { type: "text", text: systemParts.dynamicContext },
    ];
  }
  if (tools.length > 0) body.tools = tools;

  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Chat API error (${res.status}): ${errText}`);
  }

  if (!res.body) {
    throw new Error("Chat API returned an empty response body");
  }

  const parseState = createStreamParseState();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines from the buffer
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop()!; // keep incomplete last line in buffer

      for (const line of lines) {
        processSseLine(parseState, line, onText);
      }
    }

    // Flush any remaining decoded bytes and process final line(s), even if the
    // stream ended without a trailing newline. This prevents dropped tail events.
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const trailingLines = buffer.split(/\r?\n/);
      for (const line of trailingLines) {
        processSseLine(parseState, line, onText);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return toAnthropicResponse(parseState);
}
