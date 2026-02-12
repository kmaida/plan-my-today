import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../config";
import { useMCP } from "../mcp";
import type {
  AnthropicResponse,
  ChatMessage,
  ContentBlock,
  Message,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from "./types";

/** A tool_use content block (extracted from the ContentBlock union). */
type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

const MAX_TOOL_ROUNDS = 10; // Safety limit to prevent infinite loops

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

/**
 * Sliding window over conversation history to cap token consumption.
 * Keeps the first 2 messages (initial user query + assistant response for context)
 * and the most recent messages, inserting a marker where turns were dropped.
 *
 * The tail boundary is adjusted so we never split a tool_use / tool_result pair:
 * - If the tail starts on an assistant message whose content contains `tool_use`
 *   blocks, the next message (a user message with `tool_result` blocks) must be
 *   included too — so we step the cut-point back by one.
 * - If the tail starts on a user message whose content contains `tool_result`
 *   blocks (i.e. the preceding assistant `tool_use` was dropped), we step
 *   forward by one to drop the orphaned results.
 */
const MAX_HISTORY_MESSAGES = 20;

function hasToolUse(msg: Message): boolean {
  return Array.isArray(msg.content) && msg.content.some((b) => b.type === "tool_use");
}

function hasToolResult(msg: Message): boolean {
  return Array.isArray(msg.content) && msg.content.some((b) => b.type === "tool_result");
}

function windowHistory(history: Message[]): Message[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history;

  const headSize = 2;
  // 3 = headSize + 1 placeholder message
  let tailStart = history.length - (MAX_HISTORY_MESSAGES - 3);

  // Fix orphaned tool_result at the start of the tail (its tool_use was dropped)
  if (tailStart < history.length && hasToolResult(history[tailStart])) {
    tailStart++;
  }

  // Fix orphaned tool_use at the end of the head-side cut (tool_result would be
  // the first message in the tail, but we just skipped past it above — or the
  // slice landed right after an assistant tool_use whose results got dropped).
  // If the message *before* tailStart is an assistant with tool_use blocks and
  // tailStart doesn't start with matching tool_results, pull it into the tail.
  if (
    tailStart > headSize &&
    tailStart < history.length &&
    hasToolUse(history[tailStart - 1]) &&
    !hasToolResult(history[tailStart])
  ) {
    tailStart--;
  }

  return [
    ...history.slice(0, headSize),
    { role: "user" as const, content: "[Earlier conversation context omitted for brevity]" },
    ...history.slice(tailStart),
  ];
}

export interface UseChatReturn {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  clearMessages: () => void;
}

export function useChat(buildSystemPrompt?: () => string): UseChatReturn {
  const { callTool, tools: mcpTools, isConnected } = useMCP();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep a ref to the full Anthropic message history (for context continuity)
  const historyRef = useRef<Message[]>([]);
  // AbortController ref so in-flight streams can be cancelled on unmount
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight stream when the component unmounts
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(
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
      const userMsg: ChatMessage = { id: uid(), role: "user", text: userText, timestamp: Date.now() };
      setMessages((prev) => [...prev, userMsg]);

      // Add to Anthropic history
      historyRef.current.push({ role: "user", content: userText });

      try {
        const tools = toAnthropicTools(mcpTools);
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
            setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, text: accumulated } : m)));
          };

          const response = await streamChatAPI(
            windowHistory(historyRef.current),
            tools,
            buildSystemPrompt?.(),
            onTextDelta,
            abort.signal
          );

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
            // Final response — update the streaming message with final text
            setMessages((prev) =>
              prev.map((m) => (m.id === msgId ? { ...m, text: fullText } : m))
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
  }, []);

  return { messages, isLoading, error, sendMessage, clearMessages };
}

// ── Streaming API call ───────────────────────────────────────────────────────

/**
 * Stream a chat request from the Anthropic API via our server proxy.
 * Calls `onText` with the accumulated text as each delta arrives (for real-time UI).
 * Returns the reconstructed AnthropicResponse so the agentic loop logic stays unchanged.
 */
async function streamChatAPI(
  messages: Message[],
  tools: ToolDefinition[],
  system: string | undefined,
  onText: (text: string) => void,
  signal?: AbortSignal
): Promise<AnthropicResponse> {
  const body: Record<string, unknown> = { messages };
  if (system) body.system = system;
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
  const usage = { input_tokens: 0, output_tokens: 0 };

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
            break;

          case "content_block_start":
            if (event.content_block.type === "text") {
              content[event.index] = { type: "text", text: "" };
            } else if (event.content_block.type === "tool_use") {
              content[event.index] = {
                type: "tool_use",
                id: event.content_block.id,
                name: event.content_block.name,
                input: {},
              };
              partialJson.set(event.index, "");
            }
            break;

          case "content_block_delta": {
            const block = content[event.index];
            if (event.delta.type === "text_delta" && block?.type === "text") {
              block.text += event.delta.text;
              // Update accumulated text for the onText callback
              textParts[event.index] = block.text;
              onText(textParts.filter(Boolean).join(""));
            } else if (event.delta.type === "input_json_delta" && block?.type === "tool_use") {
              const current = partialJson.get(event.index) ?? "";
              partialJson.set(event.index, current + event.delta.partial_json);
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
