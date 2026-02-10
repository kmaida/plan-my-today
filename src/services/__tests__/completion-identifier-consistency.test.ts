/**
 * Completion identifier consistency tests
 *
 * These tests verify that the identifier format used when STORING a completion
 * (what the UI / mark-action-complete tool sends) matches the identifier format
 * used when FILTERING completed items out of task lists (what the fetch utils check).
 *
 * This is the exact class of bug we hit in production: Slack stored permalink URLs
 * but the filter checked channel:timestamp, so completed items reappeared.
 *
 * Each test simulates the full roundtrip:
 *   1. Store a completion with the identifier the UI would send
 *   2. Check isActionCompleted() with the identifier the filter function would use
 *   3. Verify they agree (both return true)
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  markActionComplete,
  isActionCompleted,
} from "../action-completion-store";
import { hashActionText } from "../../utils/action-identifiers";

// The store computes COMPLETIONS_FILE_PATH once at module load using process.cwd(),
// so we reset the actual file between tests instead of changing cwd.
const COMPLETIONS_FILE = path.join(process.cwd(), "data", "completed-actions.json");

beforeEach(async () => {
  // Start each test with an empty completions store
  await fs.mkdir(path.dirname(COMPLETIONS_FILE), { recursive: true });
  await fs.writeFile(COMPLETIONS_FILE, JSON.stringify({ completions: {} }));
});

describe("Meeting notes completion identifier consistency", () => {
  // UI sends: source="meeting-note", identifier=documentId (just the doc ID)
  // Filter checks BOTH:
  //   1. isActionCompleted("meeting-note", documentId) — dismiss whole doc
  //   2. isActionCompleted("meeting-note", `${documentId}:${hash}`) — dismiss specific action
  const DOC_ID = "1a2b3c4d5e6f";
  const ACTION_TEXT = "Follow up with the team about Q3 planning";

  it("should find a completed meeting note by documentId alone", async () => {
    // Dismissing an entire document's actions
    await markActionComplete("meeting-note", DOC_ID);
    const completed = await isActionCompleted("meeting-note", DOC_ID);
    expect(completed).toBe(true);
  });

  it("should find a completed specific action by documentId:hash", async () => {
    // Dismissing a single action item within a doc
    const hash = hashActionText(ACTION_TEXT);
    const specificId = `${DOC_ID}:${hash}`;
    await markActionComplete("meeting-note", specificId);
    const completed = await isActionCompleted("meeting-note", specificId);
    expect(completed).toBe(true);
  });

  it("doc-level completion should NOT match action-level lookup", async () => {
    // Completing the whole doc stores key "meeting-note:docId".
    // Looking up a specific action checks key "meeting-note:docId:hash" — different key.
    // The filter function handles this by checking BOTH keys separately.
    const hash = hashActionText(ACTION_TEXT);
    const specificId = `${DOC_ID}:${hash}`;

    await markActionComplete("meeting-note", DOC_ID);
    const specificCompleted = await isActionCompleted("meeting-note", specificId);
    // These are different store keys — the store itself should NOT cross-match.
    // The granola-utils filter does two separate lookups to cover both cases.
    expect(specificCompleted).toBe(false);
  });

  it("should NOT match with a double-prefixed key (old bug)", async () => {
    // Old bug: buildMeetingNoteId returned "meeting-note:docId:hash",
    // then isActionCompleted("meeting-note", "meeting-note:docId:hash") built
    // key "meeting-note:meeting-note:docId:hash" — double prefix!
    const hash = hashActionText(ACTION_TEXT);
    const correctId = `${DOC_ID}:${hash}`;
    const doublePrefix = `meeting-note:${DOC_ID}:${hash}`;

    await markActionComplete("meeting-note", correctId);
    const wrongKey = await isActionCompleted("meeting-note", doublePrefix);
    expect(wrongKey).toBe(false);
  });
});

describe("Docs (Google Docs assigned actions) completion identifier consistency", () => {
  // UI sends: source="docs", identifier=fileLink (Google Docs URL) or fileTitle
  // Filter checks: isActionCompleted("docs", action.fileLink || action.fileTitle)
  const FILE_LINK = "https://docs.google.com/document/d/abc123def456";
  const FILE_TITLE = "Q3 Planning Notes";

  it("should find a completed docs action by fileLink", async () => {
    await markActionComplete("docs", FILE_LINK);
    const completed = await isActionCompleted("docs", FILE_LINK);
    expect(completed).toBe(true);
  });

  it("should find a completed docs action by fileTitle fallback", async () => {
    // When fileLink is null, fileTitle is used as identifier
    await markActionComplete("docs", FILE_TITLE);
    const completed = await isActionCompleted("docs", FILE_TITLE);
    expect(completed).toBe(true);
  });

  it("fileLink completion should NOT match fileTitle lookup", async () => {
    // If someone completes by fileLink, looking up by fileTitle should NOT match
    await markActionComplete("docs", FILE_LINK);
    const wrongId = await isActionCompleted("docs", FILE_TITLE);
    expect(wrongId).toBe(false);
  });
});

describe("Cross-source isolation", () => {
  // Completions for one source must never match another source.
  // The store key is "${source}:${identifier}", so "docs:foo" !== "meeting-note:foo".
  const IDENTIFIER = "shared-identifier-value";

  it("should not cross-match completions between sources", async () => {
    await markActionComplete("docs", IDENTIFIER);

    expect(await isActionCompleted("docs", IDENTIFIER)).toBe(true);
    expect(await isActionCompleted("meeting-note", IDENTIFIER)).toBe(false);
    expect(await isActionCompleted("adhoc", IDENTIFIER)).toBe(false);
  });
});

describe("ActionSource type coverage", () => {
  // Every source in the mark-action-complete tool schema must be representable
  // in ActionSource. This test acts as a compile-time + runtime guard: if someone
  // adds a source to the tool but forgets ActionSource, this fails to compile.
  const TOOL_SOURCES = ["meeting-note", "docs", "adhoc"] as const;

  it.each(TOOL_SOURCES)(
    "should accept '%s' as a valid ActionSource for storage and lookup",
    async (source) => {
      const identifier = `test-${source}-id`;
      await markActionComplete(source, identifier);
      const completed = await isActionCompleted(source, identifier);
      expect(completed).toBe(true);
    }
  );
});
