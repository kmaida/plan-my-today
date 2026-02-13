// ── Anthropic Messages API types (subset needed for the chat proxy) ───────────

/** A single content block in a message. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "compaction"; content: string };

/** A message in the conversation (mirrors Anthropic API format). */
export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/** Tool schema sent to Claude (matches Anthropic API tool format). */
export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** Token usage from the Anthropic Messages API, including prompt cache metrics. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  /** Tokens written to the prompt cache on this request (125% of base cost). */
  cache_creation_input_tokens?: number;
  /** Tokens read from the prompt cache on this request (10% of base cost). */
  cache_read_input_tokens?: number;
}

/** Response from the Anthropic Messages API. */
export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "compaction" | null;
  usage: TokenUsage;
}

// ── Anthropic streaming event types ──────────────────────────────────────────

export interface StreamContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "compaction"; content: string };
}

export interface StreamContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "compaction_delta"; content: string };
}

export interface StreamMessageDelta {
  type: "message_delta";
  delta: { stop_reason: AnthropicResponse["stop_reason"] };
  usage: { output_tokens: number };
}

export interface StreamMessageStart {
  type: "message_start";
  message: { id: string; model: string; usage: TokenUsage };
}

export type StreamEvent =
  | StreamMessageStart
  | StreamContentBlockStart
  | StreamContentBlockDelta
  | { type: "content_block_stop"; index: number }
  | StreamMessageDelta
  | { type: "message_stop" }
  | { type: "ping" };

// ── UI-level chat types ──────────────────────────────────────────────────────

/** A tool call that was executed during an assistant turn. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

/** A chat message as displayed in the UI. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  toolCalls?: ToolCall[];
  timestamp: number;
  /** Token usage for this assistant turn (only present on final response, not intermediate tool rounds). */
  usage?: TokenUsage;
}
