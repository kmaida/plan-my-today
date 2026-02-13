import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../config";
import { useMCP } from "../mcp";
import { clearPersistedChatState, restoreChatState, saveChatState } from "./chat-persistence";
import type { SystemPromptParts } from "./system-prompt";
import type {
  AnthropicResponse,
  ChatMessage,
  ContentBlock,
  Message,
  SessionUsage,
  StreamEvent,
  TokenUsage,
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
  clearMessages: () => void;
}

export function useChat(buildSystemPrompt?: () => SystemPromptParts): UseChatReturn {
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
  // transition (same pattern ChatPanel uses for auth error scanning). This fires
  // once per turn, not on every streaming delta. By the time isLoading flips false,
  // both messages state and historyRef.current reflect the final turn state.
  const prevIsLoadingRef = useRef(false);
  useEffect(() => {
    const wasLoading = prevIsLoadingRef.current;
    prevIsLoadingRef.current = isLoading;
    if (wasLoading && !isLoading && messages.length > 0) {
      saveChatState(messages, historyRef.current, sessionUsage);
    }
  }, [isLoading, messages, sessionUsage]);

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
          setMessages((prev) => [
            ...prev,
            { id: msgId, role: "assistant", text: "", timestamp: Date.now() },
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
                m.id === msgId ? { ...m, text: fullText, usage: response.usage } : m
              )
            );
            break;
          }

          // Execute tool calls
          const toolCalls: ToolCall[] = [];
          const toolResults: ContentBlock[] = [];

          for (const block of toolUseBlocks) {
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

          // Update the streaming message with tool calls (intermediate turn)
          setMessages((prev) =>
            prev.map((m) => (m.id === msgId ? { ...m, text: fullText, toolCalls } : m))
          );

          // Add tool results to history so Claude can see them
          historyRef.current.push({ role: "user", content: toolResults });
        }

        if (rounds >= MAX_TOOL_ROUNDS) {
          setError("Reached maximum tool call rounds — stopping to avoid infinite loop");
        }
      } catch (err) {
        // Don't surface abort errors — they're intentional (unmount / new request)
        if (err instanceof DOMException && err.name === "AbortError") return;
        const msg = err instanceof Error ? err.message : "Chat request failed";
        setError(msg);
      } finally {
        setIsLoading(false);
      }
    },
    [isConnected, mcpTools, callTool, buildSystemPrompt]
  );

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

  return { messages, isLoading, error, sessionUsage, sendMessage, clearMessages };
}

// ── Streaming API call ───────────────────────────────────────────────────────

/**
 * Stream a chat request from the Anthropic API via our server proxy.
 * Calls `onText` with the accumulated text as each delta arrives (for real-time UI).
 * Returns the reconstructed AnthropicResponse so the agentic loop logic stays unchanged.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SSE stream parser with multi-event handling
async function streamChatAPI(
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

  // Reconstruct the full response from SSE events
  const content: ContentBlock[] = [];
  let stopReason: AnthropicResponse["stop_reason"] = null;
  let messageId = "";
  let model = "";
  const usage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  // Track text accumulation across blocks for the onText callback
  const textParts: string[] = [];
  // Track partial JSON for tool_use input blocks
  const partialJson: Map<number, string> = new Map();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines from the buffer
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        let event: StreamEvent;
        try {
          event = JSON.parse(data) as StreamEvent;
        } catch {
          continue;
        }

        switch (event.type) {
          case "message_start":
            messageId = event.message.id;
            model = event.message.model;
            usage.input_tokens = event.message.usage.input_tokens;
            usage.cache_creation_input_tokens =
              event.message.usage.cache_creation_input_tokens ?? 0;
            usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens ?? 0;
            break;

          case "content_block_start":
            if (event.content_block.type === "text") {
              content[event.index] = { type: "text", text: "" };
            } else if (event.content_block.type === "thinking") {
              // Adaptive thinking block — accumulate but don't stream to UI.
              // Thinking blocks must be preserved in history for multi-turn
              // conversations with tools (Anthropic API requirement).
              content[event.index] = { type: "thinking", thinking: "" };
            } else if (event.content_block.type === "tool_use") {
              content[event.index] = {
                type: "tool_use",
                id: event.content_block.id,
                name: event.content_block.name,
                input: {},
              };
              partialJson.set(event.index, "");
            } else if (event.content_block.type === "compaction") {
              content[event.index] = { type: "compaction", content: "" };
            }
            break;

          case "content_block_delta": {
            const block = content[event.index];
            if (event.delta.type === "text_delta" && block?.type === "text") {
              block.text += event.delta.text;
              // Update accumulated text for the onText callback
              textParts[event.index] = block.text;
              onText(textParts.filter(Boolean).join(""));
            } else if (event.delta.type === "thinking_delta" && block?.type === "thinking") {
              // Accumulate thinking content (not streamed to UI)
              block.thinking += event.delta.thinking;
            } else if (event.delta.type === "input_json_delta" && block?.type === "tool_use") {
              const current = partialJson.get(event.index) ?? "";
              partialJson.set(event.index, current + event.delta.partial_json);
            } else if (event.delta.type === "compaction_delta" && block?.type === "compaction") {
              // Compaction summary arrives as a single complete delta (not incremental)
              block.content = event.delta.content;
            }
            break;
          }

          case "content_block_stop": {
            const block = content[event.index];
            if (block?.type === "tool_use") {
              const jsonStr = partialJson.get(event.index);
              if (jsonStr) {
                try {
                  block.input = JSON.parse(jsonStr) as Record<string, unknown>;
                } catch {
                  block.input = {};
                }
              }
              partialJson.delete(event.index);
            }
            break;
          }

          case "message_delta":
            stopReason = event.delta.stop_reason;
            usage.output_tokens = event.usage.output_tokens;
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    content: content.filter(Boolean),
    model,
    stop_reason: stopReason,
    usage,
  };
}
