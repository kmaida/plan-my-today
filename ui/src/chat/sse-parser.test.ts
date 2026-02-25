import { describe, expect, it, vi } from "vitest";
import { createStreamParseState, processSseLine, toAnthropicResponse } from "./sse-parser";

/**
 * Build one SSE data line from an event payload.
 */
function sseLine(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}`;
}

describe("sse-parser", () => {
  it("reconstructs text deltas and updates stream metadata", () => {
    const state = createStreamParseState();
    const onText = vi.fn();

    processSseLine(
      state,
      sseLine({
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-test",
          usage: { input_tokens: 12 },
        },
      }),
      onText,
    );
    processSseLine(
      state,
      sseLine({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      onText,
    );
    processSseLine(
      state,
      sseLine({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello " },
      }),
      onText,
    );
    processSseLine(
      state,
      sseLine({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "**world**" },
      }),
      onText,
    );
    processSseLine(
      state,
      sseLine({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      }),
      onText,
    );

    const response = toAnthropicResponse(state);
    expect(response.id).toBe("msg_1");
    expect(response.model).toBe("claude-test");
    expect(response.stop_reason).toBe("end_turn");
    expect(response.usage.output_tokens).toBe(7);
    expect(response.content).toEqual([{ type: "text", text: "Hello **world**" }]);
    expect(onText).toHaveBeenLastCalledWith("Hello **world**");
  });

  it("reconstructs tool_use input_json_delta fragments", () => {
    const state = createStreamParseState();
    const onText = vi.fn();

    processSseLine(
      state,
      sseLine({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tool_1", name: "list-all-tasks-today", input: {} },
      }),
      onText,
    );
    processSseLine(
      state,
      sseLine({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"workspace":"key' },
      }),
      onText,
    );
    processSseLine(
      state,
      sseLine({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'card"}' },
      }),
      onText,
    );
    processSseLine(state, sseLine({ type: "content_block_stop", index: 1 }), onText);

    const response = toAnthropicResponse(state);
    expect(response.content).toEqual([
      {
        type: "tool_use",
        id: "tool_1",
        name: "list-all-tasks-today",
        input: { workspace: "keycard" },
      },
    ]);
    expect(onText).not.toHaveBeenCalled();
  });
});

