/**
 * Tests for LLM-assisted action item extraction.
 *
 * shouldUseLlmExtraction is a pure config check — no API calls.
 * extractActionItemsWithLlm calls the Anthropic API via fetch, so we
 * mock global.fetch to test prompt construction, response parsing,
 * deduplication, and error handling without real API calls.
 */

import {
  extractActionItemsWithLlm,
  shouldUseLlmExtraction,
} from "../llm-extraction";

// ── Mock config ──

const mockConfig: Record<string, unknown> = {
  anthropicApiKey: "test-key",
  anthropicModel: "claude-sonnet-4-5-20250929",
  userDisplayNames: ["kim"],
};

// jest.mock factories are hoisted above variable declarations, so we can't
// reference mockConfig directly. A getter defers the read to test time.
jest.mock("../../../config", () => ({
  get config() {
    return mockConfig;
  },
}));

// ── Mock logger ──

const mockWarn = jest.fn();
const mockInfo = jest.fn();

jest.mock("../../../observability/logger", () => ({
  getLogger: () => ({
    withOperation: () => ({
      warn: mockWarn,
      info: mockInfo,
    }),
  }),
}));

// ── Mock fetch ──

const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  mockWarn.mockClear();
  mockInfo.mockClear();
});

// ── shouldUseLlmExtraction ──

describe("shouldUseLlmExtraction", () => {
  it("returns true when API key is set and content is long enough", () => {
    expect(shouldUseLlmExtraction("x".repeat(200))).toBe(true);
  });

  it("returns false when content is too short", () => {
    expect(shouldUseLlmExtraction("short")).toBe(false);
  });

  it("returns false when API key is empty", () => {
    const original = mockConfig.anthropicApiKey;
    mockConfig.anthropicApiKey = "";
    expect(shouldUseLlmExtraction("x".repeat(200))).toBe(false);
    mockConfig.anthropicApiKey = original;
  });
});

// ── extractActionItemsWithLlm ──

/**
 * Helper to create a mock Anthropic API response
 */
function mockAnthropicResponse(items: unknown[]): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      content: [{ type: "text", text: JSON.stringify(items) }],
    }),
  });
}

describe("extractActionItemsWithLlm", () => {
  it("sends the correct prompt structure to the API", async () => {
    mockAnthropicResponse([]);

    await extractActionItemsWithLlm("Meeting notes content", [], ["kim"]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options.method).toBe("POST");

    const headers = options.headers;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(options.body);
    expect(body.model).toBe("claude-sonnet-4-5-20250929");
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("Meeting notes content");
  });

  it("passes an AbortSignal for timeout support", async () => {
    mockAnthropicResponse([]);

    await extractActionItemsWithLlm("content", [], []);

    const options = mockFetch.mock.calls[0][1];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("includes user names in the prompt with strict relevance filter", async () => {
    mockAnthropicResponse([]);

    await extractActionItemsWithLlm("content", [], ["kim", "alex"]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const prompt = body.messages[0].content;
    expect(prompt).toContain("kim, alex");
    // Prompt must instruct the LLM to filter to user-relevant items only
    expect(prompt).toContain("ONLY return action items that are this user's responsibility");
  });

  it("uses permissive prompt when no user names are configured", async () => {
    mockAnthropicResponse([]);

    await extractActionItemsWithLlm("content", [], []);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const prompt = body.messages[0].content;
    expect(prompt).toContain("Include all action items regardless of assignee");
    expect(prompt).not.toContain("ONLY return");
  });

  it("includes existing items in the prompt for dedup", async () => {
    mockAnthropicResponse([]);

    await extractActionItemsWithLlm(
      "content",
      ["Fix login bug", "Update docs"],
      []
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain("Fix login bug");
    expect(body.messages[0].content).toContain("Update docs");
  });

  it("parses valid action items from the response", async () => {
    mockAnthropicResponse([
      { text: "Follow up with vendor about PROJ-123", assignee: "Kim", isUrgent: false },
      { text: "Ship auth changes by Thursday", isUrgent: true },
    ]);

    const items = await extractActionItemsWithLlm("notes content", [], []);

    expect(items).toHaveLength(2);
    expect(items[0].text).toBe("Follow up with vendor about PROJ-123");
    expect(items[0].assignee).toBe("Kim");
    expect(items[0].isUrgent).toBe(false);
    expect(items[1].text).toBe("Ship auth changes by Thursday");
    expect(items[1].assignee).toBeUndefined();
    expect(items[1].isUrgent).toBe(true);
  });

  it("deduplicates against existing regex-extracted items", async () => {
    mockAnthropicResponse([
      { text: "Fix the login bug", isUrgent: false }, // duplicate
      { text: "New item from LLM", isUrgent: false }, // new
    ]);

    const items = await extractActionItemsWithLlm(
      "notes",
      ["Fix the login bug"],
      []
    );

    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("New item from LLM");
  });

  it("deduplicates with normalized matching (substring, case, whitespace)", async () => {
    mockAnthropicResponse([
      { text: "fix the login bug by Thursday", isUrgent: false }, // contains existing
      { text: "Completely new task", isUrgent: false },
    ]);

    const items = await extractActionItemsWithLlm(
      "notes",
      ["Fix the login bug"],
      []
    );

    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Completely new task");
  });

  it("deduplicates within the LLM's own output", async () => {
    mockAnthropicResponse([
      { text: "Follow up with vendor", isUrgent: false },
      { text: "Follow up with vendor about pricing", isUrgent: false }, // contains first
    ]);

    const items = await extractActionItemsWithLlm("notes", [], []);

    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Follow up with vendor");
  });

  it("ignores empty strings in existingItems during dedup", async () => {
    mockAnthropicResponse([
      { text: "A real action item", isUrgent: false },
    ]);

    // An empty string in existingItems should NOT suppress all LLM results
    const items = await extractActionItemsWithLlm("notes", [""], []);

    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("A real action item");
  });

  it("handles markdown code fences in the response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: '```json\n[{"text": "Wrapped in fences", "isUrgent": false}]\n```',
          },
        ],
      }),
    });

    const items = await extractActionItemsWithLlm("notes", [], []);

    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Wrapped in fences");
  });

  it("handles code fences with non-json language tags", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: '```text\n[{"text": "Tagged as text", "isUrgent": false}]\n```',
          },
        ],
      }),
    });

    const items = await extractActionItemsWithLlm("notes", [], []);

    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Tagged as text");
  });

  it("skips items with invalid text (too short, non-string)", async () => {
    mockAnthropicResponse([
      { text: "", isUrgent: false },
      { text: "ab", isUrgent: false }, // < 3 chars
      { text: 123, isUrgent: false }, // non-string
      { text: "Valid item here", isUrgent: false },
      null,
      "not an object",
    ]);

    const items = await extractActionItemsWithLlm("notes", [], []);

    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Valid item here");
  });

  // ── Error handling ──

  it("returns empty array on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const items = await extractActionItemsWithLlm("notes", [], []);

    expect(items).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      "Anthropic API error",
      expect.objectContaining({ status: 500 })
    );
  });

  it("returns empty array on network error (does not throw)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const items = await extractActionItemsWithLlm("notes", [], []);

    expect(items).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      "LLM extraction network error",
      expect.objectContaining({ error: "Network error" })
    );
  });

  it("returns empty array on invalid JSON response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "not valid json at all" }],
      }),
    });

    const items = await extractActionItemsWithLlm("notes", [], []);

    expect(items).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      "Failed to parse LLM response as JSON",
      expect.anything()
    );
  });

  it("returns empty array when response is not an array", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: '{"not": "an array"}' }],
      }),
    });

    const items = await extractActionItemsWithLlm("notes", [], []);

    expect(items).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      "LLM response is not an array",
      expect.anything()
    );
  });

  it("returns empty array when response has no text content", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: "image", text: null }],
      }),
    });

    const items = await extractActionItemsWithLlm("notes", [], []);

    expect(items).toEqual([]);
  });

  // ── Cross-reference pipeline compatibility ──

  it("preserves issue references in action item text for cross-referencing", async () => {
    mockAnthropicResponse([
      {
        text: "Follow up on PROJ-123 with the vendor about API changes",
        isUrgent: false,
      },
      {
        text: "Review PR #456 before Thursday standup",
        assignee: "Kim",
        isUrgent: false,
      },
    ]);

    const items = await extractActionItemsWithLlm("notes", [], []);

    expect(items).toHaveLength(2);
    // These texts contain identifiers that containsExactToken() in
    // cross-reference-utils.ts will find when detectLinearMentions
    // and detectGitHubMentions run
    expect(items[0].text).toContain("PROJ-123");
    expect(items[1].text).toContain("PR #456");
  });

  // ── Logging ──

  it("logs extraction metrics on success", async () => {
    mockAnthropicResponse([
      { text: "New action item", isUrgent: false },
    ]);

    await extractActionItemsWithLlm("x".repeat(500), ["existing"], []);

    expect(mockInfo).toHaveBeenCalledWith(
      "LLM extraction complete",
      expect.objectContaining({
        inputChars: 500,
        existingItems: 1,
        llmExtracted: 1,
      })
    );
  });
});
