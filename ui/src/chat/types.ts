// ── Anthropic Messages API types (subset needed for the chat proxy) ───────────

/** A single content block in a message. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

/** A message in the conversation (mirrors Anthropic API format). */
export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

/** Tool schema sent to Claude (matches Anthropic API tool format). */
export interface ToolDefinition {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

/** Response from the Anthropic Messages API. */
export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: ContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null
  usage: { input_tokens: number; output_tokens: number }
}

// ── UI-level chat types ──────────────────────────────────────────────────────

/** A tool call that was executed during an assistant turn. */
export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
}

/** A chat message as displayed in the UI. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  toolCalls?: ToolCall[]
  timestamp: number
}
