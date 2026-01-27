import type { DependencyMetadata } from "./types";

/**
 * Parses text to detect dependency relationships (blocked by, depends on, waiting on)
 *
 * @param text - Text to parse (issue title, description, etc.)
 * @returns Dependency metadata with blocking relationships
 */
export function parseDependencies(text: string): DependencyMetadata {
  const blockedBy: Set<string> = new Set();
  const blocks: Set<string> = new Set();
  const waitingOn: Set<string> = new Set();

  // Normalize text for pattern matching
  const normalized = text.toLowerCase();

  // Pattern: "blocked by ABC-123" or "depends on #456"
  const blockingPatterns = [
    /blocked\s+by\s+([A-Z]{2,10}-\d+|#\d+)/gi,
    /depends\s+on\s+([A-Z]{2,10}-\d+|#\d+)/gi,
    /waiting\s+(?:for|on)\s+([A-Z]{2,10}-\d+|#\d+)/gi,
    /requires\s+([A-Z]{2,10}-\d+|#\d+)/gi,
    /after\s+([A-Z]{2,10}-\d+|#\d+)/gi,
    /blocked\s+until\s+([A-Z]{2,10}-\d+|#\d+)/gi,
  ];

  for (const pattern of blockingPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      blockedBy.add(match[1]);
    }
  }

  // Pattern: "waiting on person@email.com" or "blocked by person@email.com"
  const waitingPattern = /(?:waiting|blocked)\s+(?:for|on|by)\s+([\w.-]+@[\w.-]+\.\w+)/gi;
  const waitingMatches = text.matchAll(waitingPattern);
  for (const match of waitingMatches) {
    waitingOn.add(match[1]);
  }

  // Detect if blocked by external factors (person, or generic "blocked" with no issue ID)
  const blockedByExternal = waitingOn.size > 0 ||
    (normalized.includes('blocked') && blockedBy.size === 0);

  return {
    blockedBy: Array.from(blockedBy),
    blocks: Array.from(blocks), // Will be computed from reverse lookup
    waitingOn: Array.from(waitingOn),
    blockedByExternal,
  };
}
