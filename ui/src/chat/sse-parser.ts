import type { AnthropicResponse, ContentBlock, StreamEvent, TokenUsage } from "./types";

/**
 * Mutable parsing state for an in-flight Anthropic SSE response.
 */
export interface StreamParseState {
  content: ContentBlock[];
  stopReason: AnthropicResponse["stop_reason"];
  messageId: string;
  model: string;
  usage: TokenUsage;
  textParts: string[];
  partialJson: Map<number, string>;
}

/**
 * Create an empty stream parse state container.
 */
export function createStreamParseState(): StreamParseState {
  return {
    content: [],
    stopReason: null,
    messageId: "",
    model: "",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    textParts: [],
    partialJson: new Map<number, string>(),
  };
}

/**
 * Process one SSE line and update parse state in place.
 */
export function processSseLine(
  state: StreamParseState,
  line: string,
  onText: (text: string) => void,
): void {
  if (!line.startsWith("data: ")) return;
  const data = line.slice(6).trim();
  if (data === "[DONE]") return;

  let event: StreamEvent;
  try {
    event = JSON.parse(data) as StreamEvent;
  } catch {
    return;
  }

  switch (event.type) {
    case "message_start":
      state.messageId = event.message.id;
      state.model = event.message.model;
      state.usage.input_tokens = event.message.usage.input_tokens;
      state.usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens ?? 0;
      state.usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens ?? 0;
      break;

    case "content_block_start":
      if (event.content_block.type === "text") {
        state.content[event.index] = { type: "text", text: "" };
      } else if (event.content_block.type === "thinking") {
        state.content[event.index] = { type: "thinking", thinking: "" };
      } else if (event.content_block.type === "tool_use") {
        state.content[event.index] = {
          type: "tool_use",
          id: event.content_block.id,
          name: event.content_block.name,
          input: {},
        };
        state.partialJson.set(event.index, "");
      } else if (event.content_block.type === "compaction") {
        state.content[event.index] = { type: "compaction", content: "" };
      }
      break;

    case "content_block_delta": {
      const block = state.content[event.index];
      if (event.delta.type === "text_delta" && block?.type === "text") {
        block.text += event.delta.text;
        state.textParts[event.index] = block.text;
        onText(state.textParts.filter(Boolean).join(""));
      } else if (event.delta.type === "thinking_delta" && block?.type === "thinking") {
        block.thinking += event.delta.thinking;
      } else if (event.delta.type === "input_json_delta" && block?.type === "tool_use") {
        const current = state.partialJson.get(event.index) ?? "";
        state.partialJson.set(event.index, current + event.delta.partial_json);
      } else if (event.delta.type === "compaction_delta" && block?.type === "compaction") {
        block.content = event.delta.content;
      }
      break;
    }

    case "content_block_stop": {
      const block = state.content[event.index];
      if (block?.type === "tool_use") {
        const jsonStr = state.partialJson.get(event.index);
        if (jsonStr) {
          try {
            block.input = JSON.parse(jsonStr) as Record<string, unknown>;
          } catch {
            block.input = {};
          }
        }
        state.partialJson.delete(event.index);
      }
      break;
    }

    case "message_delta":
      state.stopReason = event.delta.stop_reason;
      state.usage.output_tokens = event.usage.output_tokens;
      break;
  }
}

/**
 * Convert parse state into a final Anthropic-style message response.
 */
export function toAnthropicResponse(state: StreamParseState): AnthropicResponse {
  return {
    id: state.messageId,
    type: "message",
    role: "assistant",
    content: state.content.filter(Boolean),
    model: state.model,
    stop_reason: state.stopReason,
    usage: state.usage,
  };
}

