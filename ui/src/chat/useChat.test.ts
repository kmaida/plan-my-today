import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamChatAPI, useChat } from "./useChat";
import type { Message, ToolDefinition } from "./types";

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
        }),
      ),
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
        }),
      ),
    );

    const response = await streamChatAPI(messages, tools, null, "medium", onText);

    expect(response.content).toEqual([{ type: "text", text: "Split-chunk markdown" }]);
    expect(response.stop_reason).toBe("end_turn");
    expect(onText).toHaveBeenCalledWith("Split-chunk markdown");
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
      }),
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

