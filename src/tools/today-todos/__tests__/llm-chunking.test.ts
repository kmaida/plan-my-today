/**
 * Tests for extractActionItemsWithLlmChunked — the auto-chunking wrapper
 * that splits long documents, runs parallel LLM extraction per chunk,
 * and deduplicates the merged results.
 *
 * Approach: mock global.fetch (same as llm-extraction.test.ts) to control
 * API responses, then exercise the real chunking + dedup pipeline end-to-end.
 */

import { extractActionItemsWithLlmChunked, LLM_CONTENT_LIMIT } from "../llm-extraction";

// ── Mock config ──

jest.mock("../../../config", () => ({
  get config() {
    return {
      anthropicApiKey: "test-key",
      anthropicModel: "claude-sonnet-4-5-20250929",
    };
  },
}));

// ── Mock logger ──

const mockInfo = jest.fn();
jest.mock("../../../observability/logger", () => ({
  getLogger: () => ({
    withOperation: () => ({
      info: mockInfo,
      warn: jest.fn(),
    }),
  }),
}));

// ── Mock fetch ──

const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  mockInfo.mockClear();
});

/** Queue a mock Anthropic API response. */
function queueApiResponse(items: unknown[]): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      content: [{ type: "text", text: JSON.stringify(items) }],
    }),
  });
}

// ── Short document (single-call fast path) ────────────────────────────────────

describe("short documents (≤ LLM_CONTENT_LIMIT)", () => {
  it("makes a single API call without chunking", async () => {
    queueApiResponse([{ text: "Follow up with vendor", isUrgent: false }]);

    const result = await extractActionItemsWithLlmChunked("Short notes", [], ["kim"]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Follow up with vendor");
  });

  it("deduplicates against existing items on the single-call path", async () => {
    queueApiResponse([
      { text: "Fix the login bug by Thursday", isUrgent: false },
      { text: "Brand new item", isUrgent: false },
    ]);

    const result = await extractActionItemsWithLlmChunked(
      "Meeting notes",
      ["Fix the login bug"],
      []
    );

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Brand new item");
  });
});

// ── Long document (triggers chunking) ─────────────────────────────────────────

describe("long documents (> LLM_CONTENT_LIMIT)", () => {
  // Create content just over the limit: triggers 2 chunks
  // (chunk 1: [0, 32000], chunk 2: [28000, 33000])
  const longContent = "a".repeat(LLM_CONTENT_LIMIT + 1000);

  it("makes multiple API calls (one per chunk)", async () => {
    queueApiResponse([]);
    queueApiResponse([]);

    await extractActionItemsWithLlmChunked(longContent, [], []);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("merges results from all chunks", async () => {
    queueApiResponse([{ text: "Item from chunk 1", isUrgent: false }]);
    queueApiResponse([{ text: "Item from chunk 2", isUrgent: true }]);

    const result = await extractActionItemsWithLlmChunked(longContent, [], []);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.text)).toEqual(
      expect.arrayContaining(["Item from chunk 1", "Item from chunk 2"])
    );
  });

  it("deduplicates identical items from overlapping chunks", async () => {
    queueApiResponse([{ text: "Overlap item", isUrgent: false }]);
    queueApiResponse([{ text: "Overlap item", isUrgent: false }]);

    const result = await extractActionItemsWithLlmChunked(longContent, [], []);

    expect(result).toHaveLength(1);
  });

  it("deduplicates substring-matching items across chunks", async () => {
    queueApiResponse([{ text: "Send proposal to Acme", isUrgent: false }]);
    queueApiResponse([{ text: "Send proposal to Acme Corp by Friday", isUrgent: false }]);

    const result = await extractActionItemsWithLlmChunked(longContent, [], []);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Send proposal to Acme");
  });

  it("logs chunk count", async () => {
    queueApiResponse([]);
    queueApiResponse([]);

    await extractActionItemsWithLlmChunked(longContent, [], []);

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining("2 chunks"));
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("error handling", () => {
  const longContent = "a".repeat(LLM_CONTENT_LIMIT + 1000);

  it("returns items from successful chunks when others fail", async () => {
    queueApiResponse([{ text: "Survived chunk", isUrgent: false }]);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const result = await extractActionItemsWithLlmChunked(longContent, [], []);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Survived chunk");
  });

  it("returns empty array when all chunks fail", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    });

    const result = await extractActionItemsWithLlmChunked(longContent, [], []);

    expect(result).toEqual([]);
  });
});
