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

/** Max chars of document content sent to the LLM per chunk. ~32K chars ≈ 8K tokens. */
export const LLM_CONTENT_LIMIT = 32_000;

/** Overlap between chunks to avoid missing items that span boundaries. */
const CHUNK_OVERLAP = 4000;

/** Timeout for a single Anthropic API call (ms). 15s is generous — typical
 *  response for 32K chars is 5-10s. Keeping this tight prevents one slow call
 *  from blowing the overall request budget (UI timeout is 60s). */
const LLM_FETCH_TIMEOUT_MS = 15_000;

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
 * Checks if a text is a duplicate of any item in the comparison list.
 * Used to deduplicate within the LLM's own output and across chunks.
 *
 * Uses normalized bidirectional substring matching — if either text
 * contains the other (after lowercasing, stripping bullets/checkboxes,
 * collapsing whitespace), it's considered a duplicate.
 */
function isDuplicate(text: string, comparisonTexts: string[]): boolean {
  const normalized = normalizeForDedup(text);
  if (!normalized) return true; // empty after normalization

  for (const existing of comparisonTexts) {
    const normalizedExisting = normalizeForDedup(existing);
    // Skip empty items — every string contains "", which would
    // cause all items to be incorrectly marked as duplicates.
    if (!normalizedExisting) continue;
    if (
      normalized.includes(normalizedExisting) ||
      normalizedExisting.includes(normalized)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts action items from meeting note content using the Anthropic API.
 *
 * Acts as the authoritative filter for user relevance: reviews any items
 * found by regex extraction AND discovers additional implicit commitments
 * (e.g., "Kim will follow up with the vendor", "we agreed to ship by Thursday").
 *
 * Non-throwing: returns an empty array on any failure (network, API error,
 * invalid response). Failures are logged as warnings.
 *
 * @param content - Document text chunk (should be ≤ LLM_CONTENT_LIMIT chars)
 * @param regexItemTexts - Regex-extracted item texts for the LLM to review for user relevance
 * @param userNames - User display names for relevance filtering
 * @returns User-relevant action items (confirmed regex items + new discoveries), or empty array on failure
 */
export async function extractActionItemsWithLlm(
  content: string,
  regexItemTexts: string[],
  userNames: string[]
): Promise<LlmExtractedItem[]> {
  const logger = getLogger().withOperation("llm_extraction");

  const userContext =
    userNames.length > 0
      ? `The current user goes by: ${userNames.join(", ")}. ONLY return action items that are this user's responsibility — items explicitly assigned to them, items they volunteered for, or items clearly directed at them. Do NOT include items assigned to other people or general team tasks that aren't specifically this user's job. When in doubt, leave it out. For every item you include, set the "assignee" field to "${userNames[0]}".`
      : "Include all action items regardless of assignee.";

  const existingContext =
    regexItemTexts.length > 0
      ? `\n\nThe following items were found by an initial text scan. Review each one and include it in your output ONLY if it is this user's responsibility. Also extract any additional action items not listed here.\n\nPreviously found items:\n${regexItemTexts.map((t) => `- ${t}`).join("\n")}`
      : "";

  const prompt = `You are extracting action items from meeting notes. The content may include structured notes AND a raw meeting transcript (after a "# Transcript:" heading). Pay close attention to both sections.

Find commitments, tasks, follow-ups, and decisions that require action — especially implicit ones in natural conversation. Look for patterns like:
- "I'll send that over" / "I'll take care of that"
- "Can you handle X?" / "Would you mind doing Y?"
- "Let's circle back on Z" / "We need to follow up on..."
- "We agreed to X by Friday" / "The plan is to..."
- "I need to check on..." / "I should probably..."
- Speakers committing to actions, e.g. "Kim: yeah I'll get that done this week"

${userContext}${existingContext}

For each action item, return a JSON object with:
- "text": The action item, stated clearly and concisely. Include any referenced issue IDs (e.g., PROJ-123), PR numbers (e.g., PR #456), or project names naturally in the text.
- "assignee": The person assigned (if mentioned), or omit if unclear. In transcripts, speakers are often identified by name prefixes ("Kim:", "Alex:").
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
        max_tokens: 2048,
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

    // Skip duplicates within the LLM's own output
    if (isDuplicate(text, results.map((r) => r.text))) continue;

    results.push({
      text,
      assignee: typeof obj.assignee === "string" ? obj.assignee : undefined,
      isUrgent: obj.isUrgent === true,
    });
  }

  return results;
}

/**
 * Splits content into overlapping chunks for parallel LLM extraction.
 * Each chunk is at most `chunkSize` chars with `overlap` chars of context
 * carried over from the previous chunk to avoid missing items at boundaries.
 */
function splitIntoChunks(
  content: string,
  chunkSize: number,
  overlap: number
): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    const end = Math.min(start + chunkSize, content.length);
    chunks.push(content.substring(start, end));
    // Done — this chunk reached the end of the content
    if (end >= content.length) break;
    start = end - overlap;
    // Prevent infinite loop if overlap >= chunkSize
    if (start >= end) break;
  }

  return chunks;
}

/**
 * Extracts action items using the LLM, automatically chunking long documents.
 *
 * For documents that fit within LLM_CONTENT_LIMIT, calls extractActionItemsWithLlm
 * directly. For longer documents, splits the content into overlapping chunks,
 * runs LLM extraction on each chunk in parallel, then deduplicates the merged
 * results across chunks.
 *
 * Non-throwing: returns an empty array on any failure.
 *
 * @param content - Full document text (may exceed LLM_CONTENT_LIMIT)
 * @param regexItemTexts - Regex-extracted item texts for the LLM to review for user relevance
 * @param userNames - User display names for relevance filtering
 * @returns User-relevant action items deduplicated across chunks
 */
export async function extractActionItemsWithLlmChunked(
  content: string,
  regexItemTexts: string[],
  userNames: string[]
): Promise<LlmExtractedItem[]> {
  try {
    // Short documents: single-call fast path
    if (content.length <= LLM_CONTENT_LIMIT) {
      return extractActionItemsWithLlm(content, regexItemTexts, userNames);
    }

    const logger = getLogger().withOperation("llm_extraction_chunked");
    const chunks = splitIntoChunks(content, LLM_CONTENT_LIMIT, CHUNK_OVERLAP);
    logger.info(`Splitting ${content.length} char document into ${chunks.length} chunks for LLM extraction`);

    // Run all chunks in parallel — each chunk gets the same regex items for relevance review
    const chunkResults = await Promise.all(
      chunks.map((chunk) =>
        extractActionItemsWithLlm(chunk, regexItemTexts, userNames)
      )
    );

    // Merge all chunk results, then deduplicate across chunks
    const allItems = chunkResults.flat();
    const deduped: LlmExtractedItem[] = [];

    for (const item of allItems) {
      // Skip duplicates against other chunks' results
      if (isDuplicate(item.text, deduped.map((d) => d.text))) continue;
      deduped.push(item);
    }

    return deduped;
  } catch (error) {
    const logger = getLogger().withOperation("llm_extraction_chunked");
    logger.warn("Chunked extraction failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
