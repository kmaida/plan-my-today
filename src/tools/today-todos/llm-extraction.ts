import { config } from "../../config";
import { getLogger } from "../../observability/logger";

/**
 * Extracted action item shape — matches the interface in granola-utils.ts
 * so LLM-extracted items plug directly into the existing pipeline.
 */
export interface LlmExtractedItem {
  text: string;
  assignee?: string;
  isUrgent: boolean;
}

/** Minimum document length (chars) to justify an LLM API call. */
const MIN_CONTENT_LENGTH_FOR_LLM = 200;

/** Max chars of document content sent to the LLM (~2K tokens). */
export const LLM_CONTENT_LIMIT = 8000;

/** Timeout for the Anthropic API call (ms). */
const LLM_FETCH_TIMEOUT_MS = 30_000;

/**
 * Determines whether LLM extraction should run for a given document.
 *
 * Returns true when:
 * 1. An Anthropic API key is configured
 * 2. The document has meaningful content (≥ MIN_CONTENT_LENGTH_FOR_LLM chars)
 *
 * Always supplements regex extraction (Kim's preference) — the regex
 * runs first as a fast pass, then the LLM catches implicit items.
 */
export function shouldUseLlmExtraction(content: string): boolean {
  return Boolean(config.anthropicApiKey) && content.length >= MIN_CONTENT_LENGTH_FOR_LLM;
}

/**
 * Normalizes text for fuzzy deduplication: lowercase, collapse whitespace,
 * strip leading bullet markers and checkbox syntax.
 */
function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\s\-*•]+/, "") // strip leading bullets/dashes
    .replace(/^\[[ x]?\]\s*/, "") // strip checkbox syntax
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks if an LLM-extracted item is a duplicate of an existing regex item.
 * Uses normalized substring matching — if either text contains the other
 * (after normalization), it's considered a duplicate.
 *
 * NOTE: Bidirectional substring match is aggressive — a short regex item like
 * "Send email" will suppress a more specific LLM item like "Send email to
 * vendor about pricing by Friday". This is intentional (prefer fewer
 * duplicates over completeness), but means the LLM adds the most value
 * when regex items are specific.
 */
function isDuplicate(llmText: string, existingTexts: string[]): boolean {
  const normalizedLlm = normalizeForDedup(llmText);
  if (!normalizedLlm) return true; // empty after normalization

  for (const existing of existingTexts) {
    const normalizedExisting = normalizeForDedup(existing);
    // Skip empty existing items — every string contains "", which would
    // cause all LLM items to be incorrectly marked as duplicates.
    if (!normalizedExisting) continue;
    if (
      normalizedLlm.includes(normalizedExisting) ||
      normalizedExisting.includes(normalizedLlm)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts action items from meeting note content using the Anthropic API.
 *
 * This supplements the regex extraction in granola-utils.ts by catching
 * implicit commitments like "Kim will follow up with the vendor" or
 * "we agreed to ship by Thursday" that structured patterns miss.
 *
 * Non-throwing: returns an empty array on any failure (network, API error,
 * invalid response). Failures are logged as warnings.
 *
 * @param content - Document text (caller should truncate to LLM_CONTENT_LIMIT)
 * @param existingItems - Already-extracted item texts (for deduplication)
 * @param userNames - User display names for relevance filtering
 * @returns New action items not already found by regex, or empty array on failure
 */
export async function extractActionItemsWithLlm(
  content: string,
  existingItems: string[],
  userNames: string[]
): Promise<LlmExtractedItem[]> {
  const logger = getLogger().withOperation("llm_extraction");

  const userContext =
    userNames.length > 0
      ? `The current user goes by: ${userNames.join(", ")}. ONLY return action items that are this user's responsibility — items explicitly assigned to them, items they volunteered for, or items clearly directed at them. Do NOT include items assigned to other people or general team tasks that aren't specifically this user's job. When in doubt, leave it out.`
      : "Include all action items regardless of assignee.";

  const existingContext =
    existingItems.length > 0
      ? `\n\nThe following items have already been extracted — do NOT include duplicates:\n${existingItems.map((t) => `- ${t}`).join("\n")}`
      : "";

  const prompt = `You are extracting action items from meeting notes. Find commitments, tasks, follow-ups, and decisions that require action by the current user — especially implicit ones that might not be in a structured list.

${userContext}${existingContext}

For each action item, return a JSON object with:
- "text": The action item, stated clearly and concisely. Include any referenced issue IDs (e.g., PROJ-123), PR numbers (e.g., PR #456), or project names naturally in the text.
- "assignee": The person assigned (if mentioned), or omit if unclear
- "isUrgent": true if the item has urgency markers (today, ASAP, urgent, critical, EOD, end of day, this week), false otherwise

Return ONLY a JSON array. If no action items are found, return [].

Meeting notes:
${content}`;

  // Abort if the API doesn't respond within the timeout — prevents a hung
  // request from blocking one of the 3 concurrent batch slots indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    logger.warn("LLM extraction network error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    logger.warn("Anthropic API error", {
      status: response.status,
      error: errorText,
    });
    return [];
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content?.find((b) => b.type === "text");
  if (!textBlock?.text) {
    logger.warn("No text content in Anthropic response");
    return [];
  }

  // Parse JSON from the response — strip markdown code fences with any language tag
  let rawJson = textBlock.text.trim();
  if (rawJson.startsWith("```")) {
    rawJson = rawJson.replace(/^```\w*\s*/, "").replace(/\s*```$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    logger.warn("Failed to parse LLM response as JSON", {
      response: rawJson.substring(0, 200),
    });
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn("LLM response is not an array", { type: typeof parsed });
    return [];
  }

  // Validate and deduplicate
  const results: LlmExtractedItem[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;

    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (!text || text.length < 3) continue;

    // Skip duplicates of existing regex-extracted items
    if (isDuplicate(text, existingItems)) continue;

    // Also skip duplicates within the LLM's own output
    if (isDuplicate(text, results.map((r) => r.text))) continue;

    results.push({
      text,
      assignee: typeof obj.assignee === "string" ? obj.assignee : undefined,
      isUrgent: obj.isUrgent === true,
    });
  }

  return results;
}
