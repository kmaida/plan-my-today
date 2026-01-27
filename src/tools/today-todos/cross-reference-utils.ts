import type { CrossReferenceMetadata, GmailMessageDetail, SlackMessageDetail } from "./types";

/**
 * Detects mentions of a Linear issue across email and Slack
 *
 * @param issueId - Linear issue identifier (e.g., "ABC-123")
 * @param gmail - Array of Gmail messages to search
 * @param slack - Array of Slack messages to search
 * @returns Cross-reference metadata with mentions
 */
export function detectLinearMentions(
  issueId: string,
  gmail: GmailMessageDetail[],
  slack: SlackMessageDetail[]
): CrossReferenceMetadata {
  const mentionedIn = new Set<string>(["linear"]);
  const relatedItems: Array<{ source: string; id: string; snippet: string }> = [];

  // Search emails for issue ID
  for (const email of gmail) {
    const subject = email.subject || "";
    if (subject.includes(issueId)) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: email.id,
        snippet: subject.substring(0, 100),
      });
    }
  }

  // Search Slack messages for issue ID
  for (const msg of slack) {
    const text = msg.text || "";
    if (text.includes(issueId)) {
      mentionedIn.add("slack");
      relatedItems.push({
        source: "slack",
        id: msg.timestamp,
        snippet: text.substring(0, 100),
      });
    }
  }

  return {
    mentionedIn: Array.from(mentionedIn),
    relatedItems,
    totalMentions: relatedItems.length + 1, // +1 for Linear itself
  };
}

/**
 * Detects mentions of a GitHub PR/issue across email and Slack
 *
 * @param repo - Repository name (e.g., "owner/repo")
 * @param number - PR/issue number
 * @param gmail - Array of Gmail messages to search
 * @param slack - Array of Slack messages to search
 * @returns Cross-reference metadata with mentions
 */
export function detectGitHubMentions(
  repo: string,
  number: number,
  gmail: GmailMessageDetail[],
  slack: SlackMessageDetail[]
): CrossReferenceMetadata {
  const mentionedIn = new Set<string>(["github"]);
  const relatedItems: Array<{ source: string; id: string; snippet: string }> = [];

  // Patterns to search: "#123", "owner/repo#123", github.com URLs
  const prNumberPattern = `#${number}`;
  const repoNumberPattern = `${repo}#${number}`;
  const githubUrlPattern = `github.com/${repo}/`;

  // Search emails
  for (const email of gmail) {
    const subject = email.subject || "";
    if (
      subject.includes(prNumberPattern) ||
      subject.includes(repoNumberPattern) ||
      subject.includes(githubUrlPattern)
    ) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: email.id,
        snippet: subject.substring(0, 100),
      });
    }
  }

  // Search Slack messages
  for (const msg of slack) {
    const text = msg.text || "";
    if (
      text.includes(prNumberPattern) ||
      text.includes(repoNumberPattern) ||
      text.includes(githubUrlPattern)
    ) {
      mentionedIn.add("slack");
      relatedItems.push({
        source: "slack",
        id: msg.timestamp,
        snippet: text.substring(0, 100),
      });
    }
  }

  return {
    mentionedIn: Array.from(mentionedIn),
    relatedItems,
    totalMentions: relatedItems.length + 1, // +1 for GitHub itself
  };
}
