import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { API_BASE } from "../config";
import { useMCP } from "../mcp";
import { clearPersistedChatState, restoreChatState, saveChatState } from "./chat-persistence";
import { createStreamParseState, processSseLine, toAnthropicResponse } from "./sse-parser";
import type { SystemPromptParts } from "./system-prompt";
import { evaluateToolRound, type ToolRoundResult } from "./tool-round-utils";
import type {
  AnthropicResponse,
  ChatError,
  ChatMessage,
  ContentBlock,
  Message,
  PendingApprovalMeta,
  SessionUsage,
  StructuredToolError,
  ToolCall,
  ToolDefinition,
} from "./types";

/**
 * Error thrown by {@link streamChatAPI} when the chat proxy returns a
 * structured error body or emits a `chat_error` SSE frame mid-stream.
 * Carries the {@link StructuredToolError} so the UI can render expandable
 * detail instead of a generic "Chat request failed" string.
 */
export class ChatAPIError extends Error {
  readonly detail: StructuredToolError;
  constructor(detail: StructuredToolError) {
    super(detail.message);
    this.name = "ChatAPIError";
    this.detail = detail;
  }
}

/** Synthesize a structured error from any caught value, for fallback paths. */
function toStructuredError(err: unknown, source: string): StructuredToolError {
  if (err instanceof ChatAPIError) return err.detail;
  const message = err instanceof Error ? err.message : String(err);
  const category = err instanceof TypeError ? "network" : "unknown";
  return { category, source, message, timestamp: new Date().toISOString() };
}

/** A tool_use content block (extracted from the ContentBlock union). */
type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

const MAX_TOOL_ROUNDS = 10; // Safety limit to prevent infinite loops

/**
 * Tools whose invocation requires explicit user approval via the chat UI.
 * Before dispatching any tool in this set, the agentic loop renders an
 * ApprovalCard on the streaming message and waits for the user to click
 * Approve. The LLM cannot bypass this because dispatch happens client-side.
 *
 * Adding a tool here is the one-line extension point for new HITL gates.
 */
const TOOLS_REQUIRING_APPROVAL = new Set<string>(["delegate-task-to-roibot"]);

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
  error: ChatError | null;
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
  const [error, setError] = useState<ChatError | null>(null);
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
        setError({
          summary: "MCP client not connected — sign in first",
          detail: {
            category: "config",
            source: "mcp",
            message: "The MCP transport has not finished connecting.",
            hint: "Sign in via the dashboard and wait for the connected status.",
            timestamp: new Date().toISOString(),
          },
        });
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

          if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
            // Final response — push to history, update the streaming message
            // with final text and usage, and exit the agentic loop.
            historyRef.current.push({ role: "assistant", content: response.content });
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

          // Tool-use response. We push the assistant message AND its
          // tool_results atomically at the end of this block so a throw
          // mid-dispatch (e.g. abort during the pre-call gate) doesn't leave
          // an orphaned tool_use in history — which would 400 the next
          // Anthropic request, since every tool_use must be matched.
          const toolCalls: ToolCall[] = [];
          const toolResults: ContentBlock[] = [];

          for (const block of toolUseBlocks) {
            // Signal the header animation before the big API call starts
            if (block.name === "list-all-tasks-today" && onFetchStarted) {
              onFetchStarted();
              fetchStartedThisTurn = true;
            }

            let resultText = "";
            let isError = false;
            let shouldDispatch = true;

            // Pre-call HITL gate. Tools in TOOLS_REQUIRING_APPROVAL never
            // dispatch until the user approves via the chat UI. Denial feeds a
            // synthetic tool_result back to Claude so the conversation stays
            // well-formed and the agent knows not to retry. The LLM cannot
            // bypass this because the gate runs in client code, not on the
            // server — see ApprovalCard for the UI.
            if (TOOLS_REQUIRING_APPROVAL.has(block.name)) {
              const decision = await awaitPreCallApproval(
                msgId,
                { toolInput: block.input },
                setMessages,
                abort.signal
              );
              if (abort.signal.aborted) {
                // Stream was cancelled while the card was showing. Throw to
                // unwind out of the for loop and into the outer AbortError
                // handler; neither the assistant message nor any tool_results
                // get pushed to history (they're paired below this loop), so
                // the next turn sees clean state.
                throw new DOMException("Aborted", "AbortError");
              }
              if (!decision.approved) {
                resultText =
                  "The user denied this delegation. Do not retry. If they want " +
                  "ROIbot's help, they will explicitly ask again. Respond using only " +
                  "your own context, or ask the user how they'd like to proceed.";
                shouldDispatch = false;
              }
            }

            let errorDetails: StructuredToolError[] | undefined;
            if (shouldDispatch) {
              try {
                const result = await callTool(block.name, block.input);
                const content = result.content as
                  | Array<{ type: string; text?: string }>
                  | undefined;
                const textItem = content?.find((c) => c.type === "text");
                resultText = textItem?.text ?? JSON.stringify(result);
                // Respect the MCP protocol's isError flag from the server
                isError = result.isError === true;
                // Server-side `handleToolError` puts the structured detail on
                // `_meta.error` (single failure). Partial-failure aggregates
                // like `list-all-tasks-today` put one entry per failing source
                // on `_meta.sourceErrors`. Surface all of them.
                const meta = (result as { _meta?: Record<string, unknown> })._meta;
                if (meta) {
                  if (meta.error) {
                    errorDetails = [meta.error as StructuredToolError];
                  } else if (Array.isArray(meta.sourceErrors) && meta.sourceErrors.length > 0) {
                    errorDetails = meta.sourceErrors as StructuredToolError[];
                  }
                }
              } catch (err) {
                resultText = err instanceof Error ? err.message : String(err);
                isError = true;
                errorDetails = [toStructuredError(err, block.name)];
              }
            }
            // Denial path falls through with resultText already set above.

            toolCalls.push({
              id: block.id,
              name: block.name,
              input: block.input,
              result: resultText,
              isError,
              errorDetails,
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

          // Atomic with the assistant message: push both so Claude sees a
          // well-formed tool_use → tool_result pair on the next round.
          historyRef.current.push({ role: "assistant", content: response.content });
          historyRef.current.push({ role: "user", content: toolResults });
        }

        if (rounds >= MAX_TOOL_ROUNDS) {
          setError({
            summary: "Reached maximum tool call rounds — stopping to avoid infinite loop",
            detail: {
              category: "config",
              source: "agentic-loop",
              message: `Hit the ${MAX_TOOL_ROUNDS}-round safety limit.`,
              hint: "If the agent legitimately needs more rounds, raise MAX_TOOL_ROUNDS in useChat.ts.",
              timestamp: new Date().toISOString(),
            },
          });
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
        finalizeStreamingMessage(activeAssistantMsgId);
        const detail = toStructuredError(err, "chat");
        setError({ summary: detail.message, detail });
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

// ── Pre-call HITL gate ───────────────────────────────────────────────────────

/**
 * Stash pre-call approval state on the streaming chat message and wait for
 * the user to click Approve / Deny. The {@link ApprovalCard} component reads
 * `pendingApproval` off the message and calls `resolve(...)` once on click;
 * the returned promise un-pauses the agentic loop.
 *
 * The abort signal is respected so cancelling the stream (e.g. the user
 * clicks "stop") resolves the gate as a denial. The agentic loop sees the
 * abort flag and unwinds via its existing AbortError path without pushing
 * an orphaned tool_result back to Claude.
 */
function awaitPreCallApproval(
  msgId: string,
  meta: Omit<PendingApprovalMeta, "resolve">,
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  abortSignal: AbortSignal
): Promise<{ approved: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const clearAndResolve = (decision: { approved: boolean }) => {
      if (settled) return;
      settled = true;
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, pendingApproval: undefined } : m))
      );
      resolve(decision);
    };

    // Abort path: stop button clicked while the card is showing.
    if (abortSignal.aborted) {
      clearAndResolve({ approved: false });
      return;
    }
    abortSignal.addEventListener("abort", () => clearAndResolve({ approved: false }), {
      once: true,
    });

    const full: PendingApprovalMeta = { ...meta, resolve: clearAndResolve };
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, pendingApproval: full } : m)));
  });
}

// ── Streaming API call ───────────────────────────────────────────────────────

/**
 * Build a {@link ChatAPIError} from a non-2xx response. Tries to parse the
 * server's `{ error: StructuredToolError }` shape; falls back to a synthetic
 * structured error if the body isn't JSON or doesn't carry our shape.
 */
async function buildChatAPIErrorFromResponse(res: Response): Promise<ChatAPIError> {
  const errText = await res.text();
  const fallback: StructuredToolError = {
    category: "upstream_api",
    source: "chat",
    status: res.status,
    message: errText || `HTTP ${res.status}`,
    timestamp: new Date().toISOString(),
  };
  try {
    const parsed = JSON.parse(errText) as { error?: StructuredToolError };
    if (parsed.error) return new ChatAPIError(parsed.error);
  } catch {
    // Body wasn't JSON — fall through to fallback.
  }
  return new ChatAPIError(fallback);
}

/**
 * Build a per-line SSE dispatcher that watches for our server's
 * `event: chat_error\ndata: {...}\n\n` frames (emitted when Anthropic returns
 * a mid-stream error) and throws a typed {@link ChatAPIError}. All other lines
 * pass through to the standard Anthropic SSE parser. State (whether the next
 * `data:` line should be treated as a chat_error payload) lives in this
 * closure so it persists across chunks.
 */
function makeSseLineDispatcher(
  parseState: ReturnType<typeof createStreamParseState>,
  onText: (text: string) => void
): (line: string) => void {
  let nextDataIsChatError = false;
  return (line) => {
    if (line.startsWith("event: ")) {
      nextDataIsChatError = line.slice(7).trim() === "chat_error";
      return;
    }
    if (nextDataIsChatError && line.startsWith("data: ")) {
      nextDataIsChatError = false;
      try {
        const detail = JSON.parse(line.slice(6).trim()) as StructuredToolError;
        throw new ChatAPIError(detail);
      } catch (e) {
        if (e instanceof ChatAPIError) throw e;
        // Malformed payload — fall through and treat as a regular data line.
      }
    }
    processSseLine(parseState, line, onText);
  };
}

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
    throw await buildChatAPIErrorFromResponse(res);
  }

  if (!res.body) {
    throw new ChatAPIError({
      category: "upstream_api",
      source: "chat",
      message: "Chat API returned an empty response body",
      timestamp: new Date().toISOString(),
    });
  }

  const parseState = createStreamParseState();
  const handleLine = makeSseLineDispatcher(parseState, onText);

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
        handleLine(line);
      }
    }

    // Flush any remaining decoded bytes and process final line(s), even if the
    // stream ended without a trailing newline. This prevents dropped tail events.
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const trailingLines = buffer.split(/\r?\n/);
      for (const line of trailingLines) {
        handleLine(line);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return toAnthropicResponse(parseState);
}
