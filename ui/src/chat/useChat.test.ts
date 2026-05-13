import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, ToolDefinition } from "./types";
import { streamChatAPI, useChat } from "./useChat";

const useMCPMock = vi.fn();

vi.mock("../mcp", () => ({
  useMCP: () => useMCPMock(),
}));

/**
 * Build a single SSE data line from an event payload.
 */
function sseLine(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n`;
}

/**
 * Create a byte stream from UTF-8 text chunks.
 */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("streamChatAPI", () => {
  const messages: Message[] = [{ role: "user", content: "hello" }];
  const tools: ToolDefinition[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses final SSE event when stream ends without trailing newline", async () => {
    const onText = vi.fn();
    const chunks = [
      sseLine({
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-test",
          usage: { input_tokens: 10 },
        },
      }),
      sseLine({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      sseLine({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello **world**" },
      }),
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      })}`,
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(makeStream(chunks), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
    );

    const response = await streamChatAPI(messages, tools, null, "medium", onText);

    expect(response.stop_reason).toBe("end_turn");
    expect(response.usage.output_tokens).toBe(7);
    expect(response.content).toEqual([{ type: "text", text: "Hello **world**" }]);
    expect(onText).toHaveBeenCalledWith("Hello **world**");
  });

  it("handles JSON events split across network chunk boundaries", async () => {
    const onText = vi.fn();
    const firstHalf = `data: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Split-chunk markdown" },
    }).slice(0, 42)}`;
    const secondHalf = `${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Split-chunk markdown" },
    }).slice(42)}\n`;

    const chunks = [
      sseLine({
        type: "message_start",
        message: {
          id: "msg_2",
          model: "claude-test",
          usage: { input_tokens: 3 },
        },
      }),
      sseLine({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      firstHalf,
      secondHalf,
      sseLine({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 4 },
      }),
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(makeStream(chunks), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
    );

    const response = await streamChatAPI(messages, tools, null, "medium", onText);

    expect(response.content).toEqual([{ type: "text", text: "Split-chunk markdown" }]);
    expect(response.stop_reason).toBe("end_turn");
    expect(onText).toHaveBeenCalledWith("Split-chunk markdown");
  });
});

// ── Pre-call HITL gate ─────────────────────────────────────────────────────────

/**
 * Build an SSE stream containing a single `tool_use` block for the named tool.
 * Mirrors the Anthropic streaming format: message_start → content_block_start
 * → input_json_delta → content_block_stop → message_delta(stop_reason=tool_use).
 */
function toolUseStream(
  toolName: string,
  toolUseId: string,
  input: object
): ReadableStream<Uint8Array> {
  const inputJson = JSON.stringify(input);
  return makeStream([
    sseLine({
      type: "message_start",
      message: { id: "msg_tool", model: "claude-test", usage: { input_tokens: 10 } },
    }),
    sseLine({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: toolUseId, name: toolName, input: {} },
    }),
    sseLine({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: inputJson },
    }),
    sseLine({ type: "content_block_stop", index: 0 }),
    sseLine({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 5 },
    }),
  ]);
}

/** Build an SSE stream containing a single text block that ends the turn. */
function finalTextStream(text: string): ReadableStream<Uint8Array> {
  return makeStream([
    sseLine({
      type: "message_start",
      message: { id: "msg_final", model: "claude-test", usage: { input_tokens: 5 } },
    }),
    sseLine({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseLine({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    sseLine({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 4 },
    }),
  ]);
}

/**
 * Stub fetch to play a fixed sequence of SSE responses, one per call. After
 * the queue is exhausted, hangs forever — the agentic loop should hit its
 * resolution before then.
 */
function stubSseQueue(streams: Array<() => ReadableStream<Uint8Array>>): void {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      const stream = streams[i++];
      if (!stream) return new Promise(() => {}); // hang on unexpected calls
      return Promise.resolve(
        new Response(stream(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );
    })
  );
}

describe("useChat pre-call HITL gate", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("sets pendingApproval and does NOT dispatch the tool until the user resolves", async () => {
    // First fetch returns a tool_use for delegate-task-to-roibot. The agentic
    // loop must pause at the gate; callTool must not fire before the user
    // resolves. This is the load-bearing claim: no A2A call without a click.
    const callTool = vi.fn();
    useMCPMock.mockReturnValue({ isConnected: true, tools: [], callTool });

    stubSseQueue([
      () => toolUseStream("delegate-task-to-roibot", "tu_1", { task: "assess SREcon" }),
      // If we did dispatch (which we should not before resolve), this would
      // be consumed as the second round's response. Asserting it stays at
      // queue index 0 by checking callTool below.
      () => finalTextStream("done"),
    ]);

    const { result } = renderHook(() => useChat());

    act(() => {
      void result.current.sendMessage("ask ROIbot to assess SREcon");
    });

    // Wait for the gate to surface pendingApproval on the assistant message.
    await waitFor(() => {
      const assistant = result.current.messages.find((m) => m.role === "assistant");
      expect(assistant?.pendingApproval).toBeDefined();
    });

    // The tool must NOT have been called yet — dispatch is gated on the
    // user's click, which hasn't happened.
    expect(callTool).not.toHaveBeenCalled();
  });

  it("dispatches the tool with the original input after Approve", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ROIbot replied: ok" }],
    });
    useMCPMock.mockReturnValue({ isConnected: true, tools: [], callTool });

    stubSseQueue([
      () => toolUseStream("delegate-task-to-roibot", "tu_1", { task: "assess SREcon" }),
      () => finalTextStream("All done."),
    ]);

    const { result } = renderHook(() => useChat());

    act(() => {
      void result.current.sendMessage("ask ROIbot");
    });

    await waitFor(() => {
      const assistant = result.current.messages.find((m) => m.role === "assistant");
      expect(assistant?.pendingApproval).toBeDefined();
    });

    // Simulate the user clicking Approve.
    act(() => {
      const assistant = result.current.messages.find((m) => m.role === "assistant");
      assistant?.pendingApproval?.resolve({ approved: true });
    });

    // After resolve, the agentic loop dispatches the tool with the LLM's
    // original input. This is the affirmative case the blog post hinges on:
    // user click → call goes out.
    await waitFor(() => {
      expect(callTool).toHaveBeenCalledWith("delegate-task-to-roibot", { task: "assess SREcon" });
    });
  });

  it("never dispatches the tool after Deny and feeds a synthetic denial back", async () => {
    const callTool = vi.fn();
    useMCPMock.mockReturnValue({ isConnected: true, tools: [], callTool });

    stubSseQueue([
      () => toolUseStream("delegate-task-to-roibot", "tu_1", { task: "assess SREcon" }),
      () => finalTextStream("Acknowledged the user's denial."),
    ]);

    const { result } = renderHook(() => useChat());

    act(() => {
      void result.current.sendMessage("ask ROIbot");
    });

    await waitFor(() => {
      const assistant = result.current.messages.find((m) => m.role === "assistant");
      expect(assistant?.pendingApproval).toBeDefined();
    });

    // Simulate the user clicking Deny.
    act(() => {
      const assistant = result.current.messages.find((m) => m.role === "assistant");
      assistant?.pendingApproval?.resolve({ approved: false });
    });

    // Wait for the turn to fully unwind (the loop pushes the synthetic
    // denial as a tool_result, then makes one more streamChatAPI call which
    // returns the final ack).
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // The MCP tool must never have been called — denial is the hard gate.
    expect(callTool).not.toHaveBeenCalled();

    // The denial should be visible in the assistant message's toolCalls so
    // the LLM sees the explicit "user denied" instruction on the next round.
    const toolRound = result.current.messages.find(
      (m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0
    );
    expect(toolRound?.toolCalls?.[0].result).toMatch(/user denied/i);
    expect(toolRound?.toolCalls?.[0].isError).toBe(false);
  });
});

describe("useChat cancel behavior", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    useMCPMock.mockReturnValue({
      isConnected: true,
      tools: [],
      callTool: vi.fn(),
    });
  });

  it("marks in-flight assistant message as not streaming after cancel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      })
    );

    const { result } = renderHook(() => useChat());

    act(() => {
      void result.current.sendMessage("Plan my day");
    });

    await waitFor(() => {
      const assistant = result.current.messages.find((m) => m.role === "assistant");
      expect(assistant?.isStreaming).toBe(true);
    });

    act(() => {
      result.current.cancel();
    });

    await waitFor(() => {
      const assistant = result.current.messages.find((m) => m.role === "assistant");
      expect(assistant?.isStreaming).toBe(false);
      expect(result.current.isLoading).toBe(false);
    });
  });
});
