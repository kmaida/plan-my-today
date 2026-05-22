/**
 * Tests for email classification functions.
 *
 * These functions determine which emails are shown to the user vs. filtered out.
 * Incorrect classification can either spam the user with automated noise or
 * silently hide emails from real people that need replies.
 */

import type { GmailFullMessage } from "../email-utils";
import {
  calculateEmailPriority,
  collapseByThread,
  extractDocCommentEmails,
  extractSenderName,
  filterEmails,
  isFromIndividual,
  isLowImportance,
  isNewsletter,
} from "../email-utils";
import type { GmailMessageDetail } from "../types";

// ── isFromIndividual ──

describe("isFromIndividual", () => {
  describe("automated senders (should return false)", () => {
    it("rejects noreply addresses", () => {
      expect(isFromIndividual("noreply@example.com", "Hello")).toBe(false);
      expect(isFromIndividual("no-reply@example.com", "Hello")).toBe(false);
      expect(isFromIndividual("donotreply@example.com", "Hello")).toBe(false);
    });

    it("rejects notification addresses", () => {
      expect(isFromIndividual("notifications@github.com", "PR review")).toBe(false);
      expect(isFromIndividual("notification@linear.app", "Issue update")).toBe(false);
    });

    it("rejects known automated domains", () => {
      expect(isFromIndividual("someone@linear.app", "Task assigned")).toBe(false);
      expect(isFromIndividual("someone@github.com", "PR merged")).toBe(false);
      expect(isFromIndividual("someone@zoom.us", "Recording ready")).toBe(false);
      expect(isFromIndividual("someone@stripe.com", "Payment received")).toBe(false);
    });

    it("rejects calendar emails", () => {
      expect(isFromIndividual("calendar-notification@google.com", "Meeting invite")).toBe(false);
      expect(isFromIndividual("someone@example.com", "Google Calendar: Team meeting")).toBe(false);
    });

    it("rejects automated subject patterns", () => {
      expect(isFromIndividual("jane@company.com", "Verify your email")).toBe(false);
      expect(isFromIndividual("jane@company.com", "Your password has been reset")).toBe(false);
      expect(isFromIndividual("jane@company.com", "Welcome to Our Service")).toBe(false);
      expect(isFromIndividual("jane@company.com", "Your order has been shipped")).toBe(false);
    });

    // Note: support@ and help@ are intentionally NOT in AUTOMATED_FROM_PATTERNS.
    // Replies from support ticket systems (e.g., "Your ticket has been updated")
    // are important — the user filed that ticket and needs to see the response.
  });

  describe("individual senders (should return true)", () => {
    it("recognizes first.last@ pattern", () => {
      expect(isFromIndividual("jane.doe@company.com", "Quick question")).toBe(true);
      expect(isFromIndividual("kim_maida@example.com", "Follow up")).toBe(true);
    });

    it("recognizes display name pattern", () => {
      expect(isFromIndividual("Jane Doe <jane@company.com>", "Quick question")).toBe(true);
      expect(isFromIndividual("Kim Maida <kim@keycard.ai>", "Meeting notes")).toBe(true);
    });
  });

  describe("newsletter and team senders (should return false)", () => {
    it("rejects display names with generic team/org words", () => {
      // These match the "First Last" display name regex but are clearly not people
      expect(isFromIndividual("Cursor Team <team@mail.cursor.com>", "Plugins and More")).toBe(
        false
      );
      expect(isFromIndividual("Vercel Team <team@vercel.com>", "New features")).toBe(false);
      expect(isFromIndividual("Product Updates <updates@company.com>", "Weekly digest")).toBe(
        false
      );
      expect(isFromIndividual("Engineering Platform <eng@company.com>", "Infra news")).toBe(false);
    });

    it("rejects newsletter from-patterns even with display names", () => {
      // team@, info@, hello@ are newsletter from-patterns — caught by isNewsletter gate
      expect(isFromIndividual("Great Company <team@greatco.com>", "Our latest")).toBe(false);
      expect(isFromIndividual("Cool Startup <info@startup.io>", "Check this out")).toBe(false);
      expect(isFromIndividual("Nice People <hello@nice.com>", "Hey there")).toBe(false);
    });

    it("rejects first.last@ addresses when newsletter subject patterns match", () => {
      // Even a first.last@ address is rejected when the subject screams newsletter
      expect(isFromIndividual("news.weekly@company.com", "Weekly Digest: Top Stories")).toBe(false);
      expect(isFromIndividual("team.news@company.com", "Your Monthly Newsletter")).toBe(false);
    });

    it("does not reject real people whose names happen to share org words", () => {
      // Uncommon but real surnames should not collide with the conservative word list
      expect(isFromIndividual("Sarah Cloud <sarah.cloud@company.com>", "Sync up")).toBe(true);
    });
  });

  describe("ambiguous cases (should return false — err on the side of 'not individual')", () => {
    it("rejects single-word local parts without display names", () => {
      // "admin@company.com" with a generic subject — not enough signal
      expect(isFromIndividual("admin@company.com", "Quick update")).toBe(false);
    });
  });
});

// ── isNewsletter ──

describe("isNewsletter", () => {
  it("detects newsletter subject patterns", () => {
    expect(isNewsletter("updates@company.com", "Weekly Newsletter: AI News")).toBe(true);
    expect(isNewsletter("digest@service.com", "Your Weekly Digest")).toBe(true);
    expect(isNewsletter("someone@company.com", "Special Offer: 50% off")).toBe(true);
  });

  it("detects newsletter from patterns", () => {
    expect(isNewsletter("newsletter@company.com", "Regular subject")).toBe(true);
    expect(isNewsletter("info@company.com", "Regular subject")).toBe(true);
    expect(isNewsletter("hello@startup.io", "Check this out")).toBe(true);
  });

  it("does not flag normal emails from individuals", () => {
    expect(isNewsletter("Jane Doe <jane.doe@company.com>", "Quick question about the API")).toBe(
      false
    );
  });
});

// ── isLowImportance ──

describe("isLowImportance", () => {
  it("flags auto-replies", () => {
    expect(isLowImportance("someone@company.com", "Auto-Reply: Out of Office", false)).toBe(true);
    expect(isLowImportance("someone@company.com", "Automatic Reply: On vacation", false)).toBe(
      true
    );
    expect(isLowImportance("someone@company.com", "Out of office until Monday", false)).toBe(true);
  });

  it("flags FYI emails", () => {
    expect(isLowImportance("someone@company.com", "FYI: Team update", false)).toBe(true);
    expect(isLowImportance("someone@company.com", "For your information", false)).toBe(true);
  });

  it("respects Gmail important flag", () => {
    // Even if subject matches a low-importance pattern, Gmail importance overrides
    expect(isLowImportance("someone@company.com", "FYI: Critical info", true)).toBe(false);
  });

  it("keeps emails from individuals with action items", () => {
    // "Re:" matches low-importance pattern, but from individual + action items = keep
    expect(
      isLowImportance(
        "Jane Doe <jane.doe@company.com>",
        "Re: Action Required - please review",
        false
      )
    ).toBe(false);
  });
});

// ── filterEmails ──

describe("filterEmails", () => {
  function makeEmail(overrides: Partial<GmailMessageDetail>): GmailMessageDetail {
    return {
      id: "msg-1",
      subject: "Test subject",
      from: "Jane Doe <jane.doe@company.com>",
      link: "https://mail.google.com/mail/u/0/#inbox/msg-1",
      ...overrides,
    };
  }

  describe("always-excluded emails", () => {
    it("excludes calendar notifications", () => {
      const emails = [
        makeEmail({
          from: "calendar-notification@google.com",
          subject: "Invitation: Team standup",
        }),
        makeEmail({ subject: "Accepted: Design review" }),
        makeEmail({ subject: "Canceled event: Sprint retro" }),
      ];
      expect(filterEmails(emails)).toHaveLength(0);
    });

    it("excludes all linear.app emails", () => {
      const emails = [
        makeEmail({ from: "notifications@linear.app", subject: "KIM-123: Fix bug" }),
        makeEmail({ from: "noreply@linear.app", subject: "Overdue: KIM-456" }),
        // Even "personal-looking" linear.app addresses are excluded —
        // the old heuristic was fragile and linear.app is always automated
        makeEmail({ from: "jane.smith@linear.app", subject: "You've been assigned KIM-789" }),
      ];
      expect(filterEmails(emails)).toHaveLength(0);
    });
  });

  describe("strict filtering (default)", () => {
    it("excludes newsletters", () => {
      const emails = [
        makeEmail({ from: "newsletter@techsite.com", subject: "This Week in Tech" }),
        makeEmail({ from: "info@startup.io", subject: "Our latest product launch" }),
      ];
      expect(filterEmails(emails, true)).toHaveLength(0);
    });

    it("excludes low importance emails", () => {
      const emails = [
        makeEmail({ from: "someone@company.com", subject: "Out of office until Friday" }),
      ];
      expect(filterEmails(emails, true)).toHaveLength(0);
    });

    it("keeps emails from individuals with normal subjects", () => {
      const emails = [
        makeEmail({
          from: "Jane Doe <jane.doe@company.com>",
          subject: "Quick question about the API",
        }),
      ];
      expect(filterEmails(emails, true)).toHaveLength(1);
    });
  });

  describe("non-strict filtering (agent mode)", () => {
    it("still excludes calendar and Linear", () => {
      const emails = [
        makeEmail({ from: "calendar-notification@google.com", subject: "Meeting update" }),
        makeEmail({ from: "notifications@linear.app", subject: "Issue assigned" }),
      ];
      expect(filterEmails(emails, false)).toHaveLength(0);
    });

    it("keeps newsletters when strict filtering is off", () => {
      const emails = [makeEmail({ from: "newsletter@techsite.com", subject: "This Week in Tech" })];
      expect(filterEmails(emails, false)).toHaveLength(1);
    });

    it("keeps low importance emails when strict filtering is off", () => {
      const emails = [makeEmail({ from: "someone@company.com", subject: "FYI: Team update" })];
      expect(filterEmails(emails, false)).toHaveLength(1);
    });
  });

  describe("starred email override", () => {
    it("keeps starred newsletter emails even with strict filtering", () => {
      const emails = [
        makeEmail({
          from: "newsletter@techsite.com",
          subject: "This Week in Tech",
          isStarred: true,
        }),
      ];
      expect(filterEmails(emails, true)).toHaveLength(1);
    });

    it("keeps starred low-importance emails even with strict filtering", () => {
      const emails = [
        makeEmail({
          from: "someone@company.com",
          subject: "FYI: Team update",
          isStarred: true,
        }),
      ];
      expect(filterEmails(emails, true)).toHaveLength(1);
    });

    it("still excludes starred calendar emails (redundancy filter)", () => {
      const emails = [
        makeEmail({
          from: "calendar-notification@google.com",
          subject: "Invitation: Team standup",
          isStarred: true,
        }),
      ];
      expect(filterEmails(emails, true)).toHaveLength(0);
    });

    it("still excludes starred Linear emails (redundancy filter)", () => {
      const emails = [
        makeEmail({
          from: "notifications@linear.app",
          subject: "KIM-123: Fix bug",
          isStarred: true,
        }),
      ];
      expect(filterEmails(emails, true)).toHaveLength(0);
    });

    it("does not affect non-starred newsletters (regression guard)", () => {
      const emails = [
        makeEmail({
          from: "newsletter@techsite.com",
          subject: "This Week in Tech",
          isStarred: false,
        }),
      ];
      expect(filterEmails(emails, true)).toHaveLength(0);
    });
  });
});

// ── extractSenderName ──

describe("extractSenderName", () => {
  it("extracts display name from 'Name <email>' format", () => {
    expect(extractSenderName("Ben Ornstein <ben@example.com>")).toBe("Ben Ornstein");
    expect(extractSenderName("Kim Maida <kim@keycard.ai>")).toBe("Kim Maida");
  });

  it("strips surrounding quotes from display names", () => {
    expect(extractSenderName('"Jane Doe" <jane@example.com>')).toBe("Jane Doe");
    expect(extractSenderName("'Jane Doe' <jane@example.com>")).toBe("Jane Doe");
  });

  it("handles quoted names with commas (RFC 2822)", () => {
    expect(extractSenderName('"Doe, Jane" <jane@example.com>')).toBe("Doe, Jane");
  });

  it("falls back to email for bare '<email>' format", () => {
    expect(extractSenderName("<ben@example.com>")).toBe("ben@example.com");
  });

  it("falls back to email when display name is empty/whitespace", () => {
    // Edge case: " <user@example.com>" — regex matches but name is empty after trim
    expect(extractSenderName(" <user@example.com>")).toBe("user@example.com");
    expect(extractSenderName("  <user@example.com>")).toBe("user@example.com");
  });

  it("returns bare email addresses as-is", () => {
    expect(extractSenderName("ben@example.com")).toBe("ben@example.com");
  });

  it("trims whitespace from plain strings", () => {
    expect(extractSenderName("  ben@example.com  ")).toBe("ben@example.com");
  });
});

// ── collapseByThread ──

describe("collapseByThread", () => {
  function makeThreadEmail(overrides: Partial<GmailMessageDetail>): GmailMessageDetail {
    return {
      id: "msg-1",
      subject: "Test subject",
      from: "Jane Doe <jane.doe@company.com>",
      link: "https://mail.google.com/mail/u/0/#inbox/msg-1",
      ...overrides,
    };
  }

  it("returns a single-message thread with thread metadata", () => {
    const emails = [
      makeThreadEmail({ id: "msg-1", threadId: "thread-1", from: "Alice <alice@example.com>" }),
    ];
    const result = collapseByThread(emails);
    expect(result).toHaveLength(1);
    expect(result[0].threadMessageCount).toBe(1);
    expect(result[0].threadParticipants).toEqual(["Alice"]);
  });

  it("collapses multiple messages from the same thread into one", () => {
    const emails = [
      makeThreadEmail({
        id: "msg-1",
        threadId: "thread-1",
        from: "Alice <alice@example.com>",
        timestamp: 1000,
      }),
      makeThreadEmail({
        id: "msg-2",
        threadId: "thread-1",
        from: "Bob <bob@example.com>",
        timestamp: 2000,
      }),
      makeThreadEmail({
        id: "msg-3",
        threadId: "thread-1",
        from: "Alice <alice@example.com>",
        timestamp: 3000,
      }),
    ];
    const result = collapseByThread(emails);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg-3"); // Most recent message
    expect(result[0].threadMessageCount).toBe(3);
  });

  it("deduplicates sender names within a thread", () => {
    const emails = [
      makeThreadEmail({
        id: "msg-1",
        threadId: "thread-1",
        from: "Alice <alice@example.com>",
        timestamp: 1000,
      }),
      makeThreadEmail({
        id: "msg-2",
        threadId: "thread-1",
        from: "Bob <bob@example.com>",
        timestamp: 2000,
      }),
      makeThreadEmail({
        id: "msg-3",
        threadId: "thread-1",
        from: "Alice <alice@example.com>",
        timestamp: 3000,
      }),
    ];
    const result = collapseByThread(emails);
    expect(result[0].threadParticipants).toHaveLength(2);
    expect(result[0].threadParticipants).toContain("Alice");
    expect(result[0].threadParticipants).toContain("Bob");
  });

  it("keeps separate threads as separate items", () => {
    const emails = [
      makeThreadEmail({ id: "msg-1", threadId: "thread-1", from: "Alice <alice@example.com>" }),
      makeThreadEmail({ id: "msg-2", threadId: "thread-2", from: "Bob <bob@example.com>" }),
    ];
    const result = collapseByThread(emails);
    expect(result).toHaveLength(2);
  });

  it("passes through messages without threadId unchanged", () => {
    const emails = [
      makeThreadEmail({ id: "msg-no-thread", from: "Alice <alice@example.com>" }),
      makeThreadEmail({ id: "msg-2", threadId: "thread-1", from: "Bob <bob@example.com>" }),
    ];
    const result = collapseByThread(emails);
    expect(result).toHaveLength(2);
    // No-thread message should not have thread metadata
    const noThread = result.find((e) => e.id === "msg-no-thread");
    expect(noThread?.threadMessageCount).toBeUndefined();
    expect(noThread?.threadParticipants).toBeUndefined();
  });

  it("merges boolean flags with OR logic", () => {
    const emails = [
      makeThreadEmail({
        id: "msg-1",
        threadId: "thread-1",
        timestamp: 1000,
        from: "Alice <alice@example.com>",
        isImportant: false,
        needsReply: true,
        isStarred: false,
        hasActionItems: false,
      }),
      makeThreadEmail({
        id: "msg-2",
        threadId: "thread-1",
        timestamp: 2000,
        from: "Bob <bob@example.com>",
        isImportant: true,
        needsReply: false,
        isStarred: false,
        hasActionItems: true,
      }),
    ];
    const result = collapseByThread(emails);
    expect(result[0].isImportant).toBe(true); // true from msg-2
    expect(result[0].needsReply).toBe(true); // true from msg-1
    expect(result[0].isStarred).toBe(false); // false in both
    expect(result[0].hasActionItems).toBe(true); // true from msg-2
  });

  it("rewrites link to thread URL format", () => {
    const emails = [
      makeThreadEmail({
        id: "msg-1",
        threadId: "thread-abc",
        from: "Alice <alice@example.com>",
        link: "https://mail.google.com/mail/u/0/#inbox/msg-1",
      }),
    ];
    const result = collapseByThread(emails);
    expect(result[0].link).toBe("https://mail.google.com/mail/u/0/#inbox/thread-abc");
  });

  it("handles empty input", () => {
    expect(collapseByThread([])).toEqual([]);
  });
});

// ── calculateEmailPriority ──

describe("calculateEmailPriority", () => {
  const now = new Date();

  function makeEmail(overrides: Partial<GmailMessageDetail>): GmailMessageDetail {
    return {
      id: "msg-1",
      subject: "Test subject",
      from: "noreply@example.com",
      link: "https://mail.google.com/mail/u/0/#inbox/msg-1",
      ...overrides,
    };
  }

  it("gives starred emails a +100 boost", () => {
    const starred = makeEmail({ isStarred: true });
    const unstarred = makeEmail({ isStarred: false });
    const starredResult = calculateEmailPriority(starred, now);
    const unstarredResult = calculateEmailPriority(unstarred, now);
    expect(starredResult.score - unstarredResult.score).toBe(100);
    expect(starredResult.reasons).toContain("Starred");
  });

  it("starred noreply email outscores unstarred noreply email", () => {
    const starred = makeEmail({ from: "noreply@example.com", isStarred: true });
    const unstarred = makeEmail({ from: "noreply@example.com", isStarred: false });
    expect(calculateEmailPriority(starred, now).score).toBeGreaterThan(
      calculateEmailPriority(unstarred, now).score
    );
  });
});

// ── extractDocCommentEmails ──

describe("extractDocCommentEmails", () => {
  const COMMENT_SENDER = "comments-noreply@docs.google.com";

  /** Build a minimal GmailFullMessage with a comment notification sender. */
  function makeCommentMessage(overrides: {
    subject?: string;
    snippet?: string;
    bodyData?: string;
    from?: string;
    internalDate?: string;
  }): GmailFullMessage {
    const from = overrides.from ?? COMMENT_SENDER;
    const parts: GmailFullMessage["payload"] = {
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: overrides.subject ?? "Test subject" },
      ],
      mimeType: "text/html",
    };
    // If bodyData is provided, base64url-encode it into payload.body
    if (overrides.bodyData) {
      const encoded = Buffer.from(overrides.bodyData)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      parts.body = { data: encoded };
    }
    return {
      id: "msg-comment-1",
      payload: parts,
      snippet: overrides.snippet,
      internalDate: overrides.internalDate,
    };
  }

  describe("URL extraction by file type", () => {
    it("extracts fileId from Google Sheets comment URLs", () => {
      const msg = makeCommentMessage({
        subject: "Kim Maida (via Google Sheets) - Q1 Budget",
        snippet:
          "Check cell B4 https://docs.google.com/spreadsheets/d/SHEET_ID_123/edit?disco=AAAB more text",
      });
      const { commentEmails, remainingMessages } = extractDocCommentEmails([msg]);

      expect(commentEmails).toHaveLength(1);
      expect(commentEmails[0].fileId).toBe("SHEET_ID_123");
      expect(commentEmails[0].commentUrl).toContain("disco=AAAB");
      expect(commentEmails[0].fileTitle).toBe("Q1 Budget");
      expect(remainingMessages).toHaveLength(0);
    });

    it("extracts fileId from Google Slides comment URLs", () => {
      const msg = makeCommentMessage({
        subject: "Ben Ornstein (via Google Slides) - Pitch Deck",
        snippet: "See slide 3 https://docs.google.com/presentation/d/SLIDES_ID_456/edit?disco=AAAC",
      });
      const { commentEmails, remainingMessages } = extractDocCommentEmails([msg]);

      expect(commentEmails).toHaveLength(1);
      expect(commentEmails[0].fileId).toBe("SLIDES_ID_456");
      expect(commentEmails[0].fileTitle).toBe("Pitch Deck");
      expect(remainingMessages).toHaveLength(0);
    });

    it("still extracts fileId from Google Docs comment URLs (regression)", () => {
      const msg = makeCommentMessage({
        subject: "Ian Ornstein (via Google Docs) - Project Spec",
        snippet:
          "Please review https://docs.google.com/document/d/DOC_ID_789/comment?discussion=abc123",
      });
      const { commentEmails } = extractDocCommentEmails([msg]);

      expect(commentEmails).toHaveLength(1);
      expect(commentEmails[0].fileId).toBe("DOC_ID_789");
      expect(commentEmails[0].commentUrl).toContain("comment?discussion=abc123");
      expect(commentEmails[0].fileTitle).toBe("Project Spec");
    });

    it("handles Google Workspace domain URLs (a/{domain}/ prefix)", () => {
      const msg = makeCommentMessage({
        subject: "Person (via Google Sheets) - Report",
        snippet:
          "Review https://docs.google.com/a/keycard.ai/spreadsheets/d/DOMAIN_SHEET_ID/edit?disco=X",
      });
      const { commentEmails } = extractDocCommentEmails([msg]);

      expect(commentEmails).toHaveLength(1);
      expect(commentEmails[0].fileId).toBe("DOMAIN_SHEET_ID");
    });
  });

  describe("commentUrl preserves full deep-link", () => {
    it("preserves Sheets disco query parameter", () => {
      const msg = makeCommentMessage({
        snippet: "https://docs.google.com/spreadsheets/d/SID/edit?disco=AAABz&ts=12345",
      });
      const { commentEmails } = extractDocCommentEmails([msg]);
      expect(commentEmails[0].commentUrl).toBe(
        "https://docs.google.com/spreadsheets/d/SID/edit?disco=AAABz&ts=12345"
      );
    });

    it("preserves Docs comment discussion path", () => {
      const msg = makeCommentMessage({
        snippet: "https://docs.google.com/document/d/DID/comment?discussion=abc&hl=en",
      });
      const { commentEmails } = extractDocCommentEmails([msg]);
      expect(commentEmails[0].commentUrl).toBe(
        "https://docs.google.com/document/d/DID/comment?discussion=abc&hl=en"
      );
    });

    it("preserves Sheets fragment identifier (#gid=...&disco=...)", () => {
      const msg = makeCommentMessage({
        snippet: "https://docs.google.com/spreadsheets/d/FID/edit#gid=0&disco=XYZ end",
      });
      const { commentEmails } = extractDocCommentEmails([msg]);
      expect(commentEmails[0].commentUrl).toBe(
        "https://docs.google.com/spreadsheets/d/FID/edit#gid=0&disco=XYZ"
      );
    });
  });

  describe("subject title extraction", () => {
    it("extracts title from Sheets subject", () => {
      const msg = makeCommentMessage({
        subject: "Kim Maida (via Google Sheets) - Budget 2026",
        snippet: "https://docs.google.com/spreadsheets/d/X/edit?disco=Y",
      });
      const { commentEmails } = extractDocCommentEmails([msg]);
      expect(commentEmails[0].fileTitle).toBe("Budget 2026");
    });

    it("extracts title from Slides subject", () => {
      const msg = makeCommentMessage({
        subject: "Ben (via Google Slides) - Q1 Deck",
        snippet: "https://docs.google.com/presentation/d/X/edit?disco=Y",
      });
      const { commentEmails } = extractDocCommentEmails([msg]);
      expect(commentEmails[0].fileTitle).toBe("Q1 Deck");
    });

    it("handles Re: prefix in subject", () => {
      const msg = makeCommentMessage({
        subject: "Re: Kim Maida (via Google Sheets) - Budget 2026",
        snippet: "https://docs.google.com/spreadsheets/d/X/edit?disco=Y",
      });
      const { commentEmails } = extractDocCommentEmails([msg]);
      expect(commentEmails[0].fileTitle).toBe("Budget 2026");
    });

    it("uses full subject as fallback for unrecognized Workspace types", () => {
      const msg = makeCommentMessage({
        subject: "Person (via Google Forms) - My Survey",
        snippet: "https://docs.google.com/spreadsheets/d/X/edit?disco=Y",
      });
      const { commentEmails } = extractDocCommentEmails([msg]);
      // Falls back to full subject (minus Re:) since "via Google Forms" doesn't match
      expect(commentEmails[0].fileTitle).toBe("Person (via Google Forms) - My Survey");
    });
  });

  describe("routing: what goes where", () => {
    it("non-matching sender goes to remainingMessages", () => {
      const msg = makeCommentMessage({
        from: "jane.doe@company.com",
        snippet: "https://docs.google.com/spreadsheets/d/X/edit?disco=Y",
      });
      const { commentEmails, remainingMessages } = extractDocCommentEmails([msg]);

      expect(commentEmails).toHaveLength(0);
      expect(remainingMessages).toHaveLength(1);
    });

    it("comment sender with no recognizable URL goes to remainingMessages", () => {
      const msg = makeCommentMessage({
        snippet: "Check out https://example.com/some-page for details",
      });
      const { commentEmails, remainingMessages } = extractDocCommentEmails([msg]);

      expect(commentEmails).toHaveLength(0);
      expect(remainingMessages).toHaveLength(1);
    });
  });

  describe("dedup and body extraction", () => {
    it("deduplicates by fileId, keeping the most recent", () => {
      const older = makeCommentMessage({
        snippet: "https://docs.google.com/spreadsheets/d/SAME_ID/edit?disco=OLD",
        internalDate: "1000",
      });
      const newer = makeCommentMessage({
        snippet: "https://docs.google.com/spreadsheets/d/SAME_ID/edit?disco=NEW",
        internalDate: "2000",
      });
      // Intentionally pass older first
      const { commentEmails } = extractDocCommentEmails([older, newer]);

      expect(commentEmails).toHaveLength(1);
      expect(commentEmails[0].commentUrl).toContain("disco=NEW");
    });

    it("extracts URL from base64url-encoded body (not just snippet)", () => {
      const bodyHtml =
        '<a href="https://docs.google.com/spreadsheets/d/BODY_ID/edit?disco=Z">View</a>';
      const msg = makeCommentMessage({
        bodyData: bodyHtml,
        subject: "Person (via Google Sheets) - From Body",
      });
      const { commentEmails } = extractDocCommentEmails([msg]);

      expect(commentEmails).toHaveLength(1);
      expect(commentEmails[0].fileId).toBe("BODY_ID");
      // commentUrl should stop at the closing " of the href attribute
      expect(commentEmails[0].commentUrl).toBe(
        "https://docs.google.com/spreadsheets/d/BODY_ID/edit?disco=Z"
      );
    });
  });

  it("handles empty input", () => {
    const { commentEmails, remainingMessages } = extractDocCommentEmails([]);
    expect(commentEmails).toEqual([]);
    expect(remainingMessages).toEqual([]);
  });
});
