/**
 * Tests for calculateGitHubPriority — additive boolean-flag scoring
 * for GitHub PRs and issues.
 *
 * Score formula (base 50):
 *   PR:   review-requested +100, authored +70, assigned +60, owned-repo-only +40, draft -30
 *   Issue: authored +70, assigned +60, owned-repo-only +40
 *   Recency: <4h +40, <24h +20, <48h +10
 *   isOwnedRepo only adds when no personal-relationship flag (isReviewRequested/isAssigned/isAuthored) is set
 */

import { calculateGitHubPriority } from "../github-utils";
import type { GitHubIssueDetail, GitHubPRDetail } from "../types";

// Fixed reference date — keeps all recency calculations deterministic
const NOW = new Date("2026-02-19T12:00:00Z");
// Old enough (>48h) to produce zero recency boost
const OLD = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

function makePR(overrides: Partial<GitHubPRDetail> = {}): GitHubPRDetail {
  return {
    id: 1,
    number: 1,
    title: "Test PR",
    url: "https://github.com/org/repo/pull/1",
    repo: "org/repo",
    isAssigned: false,
    isReviewRequested: false,
    isAuthored: false,
    isOwnedRepo: false,
    isBot: false,
    dismissalId: "org/repo#1",
    updatedAt: OLD,
    isDraft: false,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<GitHubIssueDetail> = {}): GitHubIssueDetail {
  return {
    id: 1,
    number: 1,
    title: "Test Issue",
    url: "https://github.com/org/repo/issues/1",
    repo: "org/repo",
    isAssigned: false,
    isAuthored: false,
    isOwnedRepo: false,
    isBot: false,
    dismissalId: "org/repo#1",
    updatedAt: OLD,
    ...overrides,
  };
}

// ── PR scoring ────────────────────────────────────────────────────────────────

describe("calculateGitHubPriority — PRs", () => {
  it("review-requested scores high (150 = 50 + 100)", () => {
    const meta = calculateGitHubPriority(makePR({ isReviewRequested: true }), NOW);
    expect(meta.score).toBe(150);
    expect(meta.category).toBe("high");
    expect(meta.reasons).toContain("Review requested");
    expect(meta.signals.itemType).toBe("pr_review");
  });

  it("authored scores medium (120 = 50 + 70)", () => {
    const meta = calculateGitHubPriority(makePR({ isAuthored: true }), NOW);
    expect(meta.score).toBe(120);
    expect(meta.category).toBe("medium");
    expect(meta.reasons).toContain("Authored");
    expect(meta.signals.itemType).toBe("pr_authored");
  });

  it("assigned scores medium (110 = 50 + 60)", () => {
    const meta = calculateGitHubPriority(makePR({ isAssigned: true }), NOW);
    expect(meta.score).toBe(110);
    expect(meta.category).toBe("medium");
    expect(meta.reasons).toContain("Assigned");
    expect(meta.signals.itemType).toBe("pr_assigned");
  });

  it("owned-repo-only scores medium (90 = 50 + 40)", () => {
    const meta = calculateGitHubPriority(makePR({ isOwnedRepo: true }), NOW);
    expect(meta.score).toBe(90);
    expect(meta.category).toBe("medium");
    expect(meta.reasons).toContain("Open on your repo");
    expect(meta.signals.itemType).toBe("pr_owned");
  });

  it("review + assigned stacks additively (210 → critical)", () => {
    const meta = calculateGitHubPriority(
      makePR({ isReviewRequested: true, isAssigned: true }),
      NOW
    );
    expect(meta.score).toBe(210); // 50 + 100 + 60
    expect(meta.category).toBe("critical");
    expect(meta.reasons).toContain("Review requested");
    expect(meta.reasons).toContain("Assigned");
  });

  it("review + authored stacks additively (220 → critical)", () => {
    const meta = calculateGitHubPriority(
      makePR({ isReviewRequested: true, isAuthored: true }),
      NOW
    );
    expect(meta.score).toBe(220); // 50 + 100 + 70
    expect(meta.category).toBe("critical");
  });

  it("isOwnedRepo does NOT add when other flags are set", () => {
    const meta = calculateGitHubPriority(makePR({ isAuthored: true, isOwnedRepo: true }), NOW);
    expect(meta.score).toBe(120); // 50 + 70 only — owned-repo baseline skipped
    expect(meta.reasons).not.toContain("Open on your repo");
  });

  it("draft PR deducts 30 points", () => {
    const meta = calculateGitHubPriority(makePR({ isReviewRequested: true, isDraft: true }), NOW);
    expect(meta.score).toBe(120); // 50 + 100 - 30
    expect(meta.reasons).toContain("Draft");
    expect(meta.signals.isDraft).toBe(true);
  });

  describe("recency boosts", () => {
    it("very recent (<4h) adds 40", () => {
      const updatedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
      const meta = calculateGitHubPriority(makePR({ isAuthored: true, updatedAt }), NOW);
      expect(meta.score).toBe(160); // 50 + 70 + 40
      expect(meta.reasons).toContain("Very recent update");
    });

    it("recent (<24h, >4h) adds 20", () => {
      const updatedAt = new Date(NOW.getTime() - 12 * 60 * 60 * 1000).toISOString();
      const meta = calculateGitHubPriority(makePR({ isAuthored: true, updatedAt }), NOW);
      expect(meta.score).toBe(140); // 50 + 70 + 20
      expect(meta.reasons).toContain("Recent update");
    });

    it("mildly recent (<48h, >24h) adds 10", () => {
      const updatedAt = new Date(NOW.getTime() - 36 * 60 * 60 * 1000).toISOString();
      const meta = calculateGitHubPriority(makePR({ isAuthored: true, updatedAt }), NOW);
      expect(meta.score).toBe(130); // 50 + 70 + 10
      expect(meta.reasons).not.toContain("Very recent update");
      expect(meta.reasons).not.toContain("Recent update");
    });

    it("old (>48h) adds no recency boost", () => {
      const meta = calculateGitHubPriority(makePR({ isAuthored: true }), NOW); // OLD
      expect(meta.score).toBe(120);
    });
  });
});

// ── Issue scoring ────────────────────────────────────────────────────────────

describe("calculateGitHubPriority — Issues", () => {
  it("assigned scores medium (110)", () => {
    const meta = calculateGitHubPriority(makeIssue({ isAssigned: true }), NOW);
    expect(meta.score).toBe(110);
    expect(meta.category).toBe("medium");
    expect(meta.reasons).toContain("Assigned");
    expect(meta.signals.itemType).toBe("issue");
    expect(meta.signals.isDraft).toBe(false); // issues never have draft state
  });

  it("authored scores medium (120)", () => {
    const meta = calculateGitHubPriority(makeIssue({ isAuthored: true }), NOW);
    expect(meta.score).toBe(120);
    expect(meta.reasons).toContain("Authored");
  });

  it("owned-repo-only scores medium (90)", () => {
    const meta = calculateGitHubPriority(makeIssue({ isOwnedRepo: true }), NOW);
    expect(meta.score).toBe(90);
    expect(meta.reasons).toContain("Open on your repo");
  });

  it("assigned + authored stacks (180 → critical)", () => {
    const meta = calculateGitHubPriority(makeIssue({ isAssigned: true, isAuthored: true }), NOW);
    expect(meta.score).toBe(180); // 50 + 60 + 70
    expect(meta.category).toBe("critical");
  });

  it("isOwnedRepo does NOT add when other flags are set on issue", () => {
    const meta = calculateGitHubPriority(makeIssue({ isAssigned: true, isOwnedRepo: true }), NOW);
    expect(meta.score).toBe(110); // 50 + 60 only
    expect(meta.reasons).not.toContain("Open on your repo");
  });
});

// ── Bot detection ─────────────────────────────────────────────────────────────

describe("calculateGitHubPriority — bot penalty", () => {
  it("dependency bot PR (owned-repo) scores -10 (50 - 60) and does NOT add owned-repo bonus", () => {
    const meta = calculateGitHubPriority(makePR({ isOwnedRepo: true, isBot: true }), NOW);
    expect(meta.score).toBe(-10); // 50 - 60 — isOwnedRepo bonus suppressed for bots
    expect(meta.category).toBe("low");
    expect(meta.reasons).toContain("Automated");
    expect(meta.reasons).not.toContain("Open on your repo");
    expect(meta.signals.isBot).toBe(true);
  });

  it("dependency bot PR with review requested is NOT penalized", () => {
    const meta = calculateGitHubPriority(makePR({ isReviewRequested: true, isBot: true }), NOW);
    expect(meta.score).toBe(150); // 50 + 100 — no penalty, no owned-repo bonus (review flag blocks it anyway)
    expect(meta.reasons).not.toContain("Automated");
    expect(meta.signals.isBot).toBe(true); // flag is set even though penalty was skipped
  });

  it("github-actions[bot] PR is NOT penalized (not in dependency bot list)", () => {
    // isBot is false because isDependencyBot("github-actions[bot]") returns false
    const meta = calculateGitHubPriority(makePR({ isOwnedRepo: true, isBot: false }), NOW);
    expect(meta.score).toBe(90); // 50 + 40, no penalty
    expect(meta.reasons).toContain("Open on your repo");
    expect(meta.reasons).not.toContain("Automated");
    expect(meta.signals.isBot).toBe(false);
  });

  it("non-bot PR is unaffected and signals.isBot is false", () => {
    const meta = calculateGitHubPriority(makePR({ isAuthored: true }), NOW);
    expect(meta.score).toBe(120); // 50 + 70
    expect(meta.signals.isBot).toBe(false);
  });

  it("PAT-authored bot PR (isAuthored: true, isBot: true) is still de-prioritized", () => {
    // Simulates Snyk configured via PAT: user.login === username but branch is snyk-fix-*
    const meta = calculateGitHubPriority(makePR({ isAuthored: true, isBot: true }), NOW);
    expect(meta.score).toBe(-10); // 50 - 60 — authored bonus suppressed for bots
    expect(meta.category).toBe("low");
    expect(meta.reasons).toContain("Automated");
    expect(meta.reasons).not.toContain("Authored");
    expect(meta.signals.itemType).toBe("pr_automated");
    expect(meta.signals.isBot).toBe(true);
  });

  it("review-requested bot PR with isAuthored: all bonuses stack (220 = 50 + 100 + 70)", () => {
    const meta = calculateGitHubPriority(
      makePR({ isReviewRequested: true, isAuthored: true, isBot: true }),
      NOW
    );
    expect(meta.score).toBe(220); // 50 + 100 + 70 — bot exempted by review request, authored stacks
    expect(meta.reasons).toContain("Review requested");
    expect(meta.reasons).toContain("Authored");
    expect(meta.reasons).not.toContain("Automated");
    expect(meta.signals.itemType).toBe("pr_review");
  });

  it("PR with no flags gets itemType pr_other", () => {
    const meta = calculateGitHubPriority(makePR(), NOW);
    expect(meta.score).toBe(50); // base only
    expect(meta.signals.itemType).toBe("pr_other");
  });

  it("dependency bot issue (owned-repo) scores -10 and does NOT add owned-repo bonus", () => {
    const meta = calculateGitHubPriority(makeIssue({ isOwnedRepo: true, isBot: true }), NOW);
    expect(meta.score).toBe(-10); // 50 - 60 — isOwnedRepo bonus suppressed for bots
    expect(meta.category).toBe("low");
    expect(meta.reasons).toContain("Automated");
    expect(meta.reasons).not.toContain("Open on your repo");
    expect(meta.signals.isBot).toBe(true);
  });
});
