/**
 * Tests for email classification functions.
 *
 * These functions determine which emails are shown to the user vs. filtered out.
 * Incorrect classification can either spam the user with automated noise or
 * silently hide emails from real people that need replies.
 */

import {
  isFromIndividual,
  isNewsletter,
  isLowImportance,
  filterEmails,
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
    expect(isNewsletter("Jane Doe <jane.doe@company.com>", "Quick question about the API")).toBe(false);
  });
});

// ── isLowImportance ──

describe("isLowImportance", () => {
  it("flags auto-replies", () => {
    expect(isLowImportance("someone@company.com", "Auto-Reply: Out of Office", false)).toBe(true);
    expect(isLowImportance("someone@company.com", "Automatic Reply: On vacation", false)).toBe(true);
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
    expect(isLowImportance("Jane Doe <jane.doe@company.com>", "Re: Action Required - please review", false)).toBe(false);
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
        makeEmail({ from: "calendar-notification@google.com", subject: "Invitation: Team standup" }),
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
        makeEmail({ from: "Jane Doe <jane.doe@company.com>", subject: "Quick question about the API" }),
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
      const emails = [
        makeEmail({ from: "newsletter@techsite.com", subject: "This Week in Tech" }),
      ];
      expect(filterEmails(emails, false)).toHaveLength(1);
    });

    it("keeps low importance emails when strict filtering is off", () => {
      const emails = [
        makeEmail({ from: "someone@company.com", subject: "FYI: Team update" }),
      ];
      expect(filterEmails(emails, false)).toHaveLength(1);
    });
  });
});
