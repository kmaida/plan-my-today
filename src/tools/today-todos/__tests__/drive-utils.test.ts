/**
 * Tests for Google Drive utilities:
 * - fetchDriveActionItems: Drive v3 owned-files scan with per-file comment check (task list)
 * - fetchAssignedActions: Drive Activity API (used by standalone MCP tool)
 * - calculateDrivePriority: Priority scoring for Drive items
 */

import {
  calculateDrivePriority,
  fetchAssignedActions,
  fetchDriveActionItems,
} from "../drive-utils";
import type { AssignedActionDetail } from "../types";

// Fixed reference date — keeps recency calculations deterministic
const NOW = new Date("2026-02-26T12:00:00Z");
// Old enough (>24h) to produce zero recency boost
const OLD = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
// Recent enough (<1h) for max recency boost
const RECENT = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();

// ── fetchDriveActionItems ──

/** Build a Drive v3 files.list response */
function makeFilesListResponse(
  files: Array<{
    id?: string;
    name?: string;
    webViewLink?: string;
    modifiedTime?: string;
  }>
) {
  return { files };
}

/**
 * Mock global.fetch with URL-based routing.
 * Returns different responses based on the URL called.
 */
function mockFetchRouted(routes: Record<string, { body: unknown; ok?: boolean; status?: number }>) {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test helper with URL routing logic
  return jest.fn().mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const decoded = decodeURIComponent(urlStr);
    for (const [pattern, config] of Object.entries(routes)) {
      if (decoded.includes(pattern)) {
        return {
          ok: config.ok ?? true,
          status: config.status ?? 200,
          statusText: (config.ok ?? true) ? "OK" : "Error",
          json: async () => config.body,
        };
      }
    }
    // Default: 404
    return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
  });
}

describe("fetchDriveActionItems", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /** Build a comments response with N unresolved comments */
  function makeCommentsResponse(count: number) {
    return {
      comments: Array.from({ length: count }, (_, i) => ({
        id: `c${i + 1}`,
        content: `Comment ${i + 1}`,
        resolved: false,
        createdTime: "2026-02-25T10:00:00Z",
      })),
    };
  }

  it("returns empty array when no owned files are returned", async () => {
    global.fetch = mockFetchRouted({
      "files?": { body: makeFilesListResponse([]) },
    });

    const results = await fetchDriveActionItems("fake-token");
    expect(results).toHaveLength(0);
  });

  it("skips files with no id", async () => {
    global.fetch = mockFetchRouted({
      "files?": {
        body: makeFilesListResponse([{ name: "No ID Doc" }, { id: "file1", name: "Has ID" }]),
      },
      "files/file1/comments": { body: makeCommentsResponse(1) },
    });

    const results = await fetchDriveActionItems("fake-token");
    expect(results).toHaveLength(1);
    expect(results[0].fileTitle).toBe("Has ID");
  });

  it("uses 'Document' fallback when file has no name", async () => {
    global.fetch = mockFetchRouted({
      "files?": {
        body: makeFilesListResponse([
          { id: "file1", webViewLink: "https://docs.google.com/document/d/file1/edit" },
        ]),
      },
      "files/file1/comments": { body: makeCommentsResponse(1) },
    });

    const results = await fetchDriveActionItems("fake-token");
    expect(results).toHaveLength(1);
    expect(results[0].fileTitle).toBe("Document");
  });

  it("includes files with only an id (no name or webViewLink)", async () => {
    // The owned-files scan filters only on !!f.id, so files with no name/link are still checked
    global.fetch = mockFetchRouted({
      "files?": {
        body: makeFilesListResponse([{ id: "orphan" }, { id: "file1", name: "Has Name" }]),
      },
      "files/orphan/comments": { body: makeCommentsResponse(0) },
      "files/file1/comments": { body: makeCommentsResponse(1) },
    });

    const results = await fetchDriveActionItems("fake-token");
    expect(results).toHaveLength(1);
    expect(results[0].fileTitle).toBe("Has Name");
  });

  it("constructs fileLink from id when webViewLink is missing", async () => {
    global.fetch = mockFetchRouted({
      "files?": { body: makeFilesListResponse([{ id: "file1", name: "Test" }]) },
      "files/file1/comments": { body: makeCommentsResponse(1) },
    });

    const results = await fetchDriveActionItems("fake-token");
    expect(results[0].fileLink).toBe("https://drive.google.com/open?id=file1");
  });

  it("throws AuthenticationError on 401", async () => {
    global.fetch = mockFetchRouted({
      "files?": { body: {}, ok: false, status: 401 },
    });

    await expect(fetchDriveActionItems("fake-token")).rejects.toThrow(/Google Drive/);
  });

  it("throws AuthenticationError on 403", async () => {
    global.fetch = mockFetchRouted({
      "files?": { body: {}, ok: false, status: 403 },
    });

    await expect(fetchDriveActionItems("fake-token")).rejects.toThrow(/Google Drive/);
  });

  it("returns files with unresolved comments from owned-files scan", async () => {
    global.fetch = mockFetchRouted({
      "files?": {
        body: makeFilesListResponse([
          {
            id: "owned1",
            name: "My Doc",
            webViewLink: "https://docs.google.com/document/d/owned1/edit",
            modifiedTime: "2026-02-25T10:00:00Z",
          },
        ]),
      },
      "files/owned1/comments": {
        body: {
          comments: [
            {
              id: "c1",
              content: "Please review",
              resolved: false,
              createdTime: "2026-02-25T12:00:00Z",
            },
          ],
        },
      },
    });

    const results = await fetchDriveActionItems("fake-token");
    expect(results).toHaveLength(1);
    expect(results[0].fileTitle).toBe("My Doc");
    expect(results[0].driveType).toBe("unresolved-comment");
    expect(results[0].commentCount).toBe(1);
    expect(results[0].isAssignment).toBe(false);
  });

  it("skips files with zero unresolved comments", async () => {
    global.fetch = mockFetchRouted({
      "files?": {
        body: makeFilesListResponse([
          { id: "owned1", name: "All Resolved" },
          { id: "owned2", name: "Has Comments" },
        ]),
      },
      "files/owned1/comments": { body: { comments: [] } },
      "files/owned2/comments": {
        body: {
          comments: [
            {
              id: "c1",
              content: "Action needed",
              resolved: false,
              createdTime: "2026-02-25T09:00:00Z",
            },
            {
              id: "c2",
              content: "Also this",
              resolved: false,
              createdTime: "2026-02-25T10:00:00Z",
            },
          ],
        },
      },
    });

    const results = await fetchDriveActionItems("fake-token");
    expect(results).toHaveLength(1);
    expect(results[0].fileTitle).toBe("Has Comments");
    expect(results[0].commentCount).toBe(2);
  });

  it("returns empty array when owned-files scan fails with non-auth error", async () => {
    global.fetch = mockFetchRouted({
      "files?": { body: {}, ok: false, status: 500 },
    });

    const results = await fetchDriveActionItems("fake-token");
    expect(results).toHaveLength(0);
  });
});

// ── fetchAssignedActions ──

/**
 * Build a Drive Activity API response with one activity.
 * Callers override the fields relevant to their test case.
 */
function makeActivityResponse(overrides: {
  actorIsCurrentUser?: boolean;
  assignedUserIsCurrentUser?: boolean;
  hasAssignment?: boolean;
  mentionedUserIsCurrentUser?: boolean;
  hasMentionedUsers?: boolean;
  title?: string;
  itemName?: string;
  timestamp?: string;
}) {
  const {
    actorIsCurrentUser = false,
    assignedUserIsCurrentUser = false,
    hasAssignment = false,
    mentionedUserIsCurrentUser = false,
    hasMentionedUsers = false,
    title = "Test Doc",
    itemName = "items/abc123",
    timestamp = OLD,
  } = overrides;

  const comment: Record<string, unknown> = {};
  if (hasAssignment) {
    comment.assignment = {
      assignedUser: { knownUser: { isCurrentUser: assignedUserIsCurrentUser } },
    };
  }
  if (hasMentionedUsers) {
    comment.mentionedUsers = [{ knownUser: { isCurrentUser: mentionedUserIsCurrentUser } }];
  }

  return {
    activities: [
      {
        primaryActionDetail: { comment },
        actors: [{ user: { knownUser: { isCurrentUser: actorIsCurrentUser } } }],
        targets: [{ driveItem: { title, name: itemName } }],
        timestamp,
      },
    ],
  };
}

/** Mock global.fetch to return a given JSON body */
function mockFetch(body: unknown, ok = true, status = 200) {
  return jest.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  });
}

describe("fetchAssignedActions", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns item when assignedUser.isCurrentUser is true (standard assignment)", async () => {
    global.fetch = mockFetch(
      makeActivityResponse({
        hasAssignment: true,
        assignedUserIsCurrentUser: true,
      })
    );

    const results = await fetchAssignedActions("fake-token", 14);
    expect(results).toHaveLength(1);
    expect(results[0].actionType).toBe("assigned to you");
    expect(results[0].driveType).toBe("assignment");
    expect(results[0].fileTitle).toBe("Test Doc");
  });

  it("returns item when mentionedUser.isCurrentUser is true (standard mention)", async () => {
    global.fetch = mockFetch(
      makeActivityResponse({
        hasMentionedUsers: true,
        mentionedUserIsCurrentUser: true,
      })
    );

    const results = await fetchAssignedActions("fake-token", 14);
    expect(results).toHaveLength(1);
    expect(results[0].actionType).toBe("mentioned you");
    expect(results[0].driveType).toBe("mention");
  });

  it("returns item for self-assignment (actor is self + assignment exists + assignedUser flag not set)", async () => {
    global.fetch = mockFetch(
      makeActivityResponse({
        actorIsCurrentUser: true,
        hasAssignment: true,
        assignedUserIsCurrentUser: false,
      })
    );

    const results = await fetchAssignedActions("fake-token", 14);
    expect(results).toHaveLength(1);
    expect(results[0].actionType).toBe("assigned to you");
    expect(results[0].driveType).toBe("assignment");
    expect(results[0].isAssignment).toBe(true);
  });

  it("does NOT double-count when assignedUser flag IS set and actor is also self", async () => {
    global.fetch = mockFetch(
      makeActivityResponse({
        actorIsCurrentUser: true,
        hasAssignment: true,
        assignedUserIsCurrentUser: true,
      })
    );

    const results = await fetchAssignedActions("fake-token", 14);
    // Should produce exactly 1 item, not 2
    expect(results).toHaveLength(1);
  });

  it("filters out activity with no assignment, no mention, and actor is not self", async () => {
    global.fetch = mockFetch(
      makeActivityResponse({
        actorIsCurrentUser: false,
        hasAssignment: false,
        hasMentionedUsers: false,
      })
    );

    const results = await fetchAssignedActions("fake-token", 14);
    expect(results).toHaveLength(0);
  });

  it("filters out self-actor activity that has no assignment (just a regular comment)", async () => {
    global.fetch = mockFetch(
      makeActivityResponse({
        actorIsCurrentUser: true,
        hasAssignment: false,
        hasMentionedUsers: false,
      })
    );

    const results = await fetchAssignedActions("fake-token", 14);
    expect(results).toHaveLength(0);
  });

  it("skips items with no title AND no fileId (Untitled bug guard)", async () => {
    global.fetch = mockFetch(
      makeActivityResponse({
        hasAssignment: true,
        assignedUserIsCurrentUser: true,
        title: "",
        itemName: "", // no "items/" prefix = no fileId extracted
      })
    );

    const results = await fetchAssignedActions("fake-token", 14);
    expect(results).toHaveLength(0);
  });

  it("falls back to 'Document' title when title is empty but fileId exists", async () => {
    global.fetch = mockFetch(
      makeActivityResponse({
        hasAssignment: true,
        assignedUserIsCurrentUser: true,
        title: "",
        itemName: "items/file123",
      })
    );

    const results = await fetchAssignedActions("fake-token", 14);
    expect(results).toHaveLength(1);
    expect(results[0].fileTitle).toBe("Document");
    expect(results[0].fileLink).toBe("https://drive.google.com/open?id=file123");
  });

  it("returns empty array when API returns no activities", async () => {
    global.fetch = mockFetch({ activities: [] });

    const results = await fetchAssignedActions("fake-token", 14);
    expect(results).toHaveLength(0);
  });

  it("returns empty array on non-auth API error", async () => {
    global.fetch = mockFetch({}, false, 500);

    const results = await fetchAssignedActions("fake-token", 14);
    expect(results).toHaveLength(0);
  });

  it("throws AuthenticationError on 401", async () => {
    global.fetch = mockFetch({}, false, 401);

    await expect(fetchAssignedActions("fake-token", 14)).rejects.toThrow(/Google Drive Activity/);
  });
});

// ── calculateDrivePriority ──

function makeAction(overrides: Partial<AssignedActionDetail> = {}): AssignedActionDetail {
  return {
    fileTitle: "Test Doc",
    actionType: "assigned to you",
    fileLink: "https://drive.google.com/open?id=abc",
    timestamp: OLD,
    isAssignment: false,
    driveType: "mention",
    ...overrides,
  };
}

describe("calculateDrivePriority", () => {
  it("scores assignments higher than mentions", () => {
    const assignment = calculateDrivePriority(makeAction({ isAssignment: true }), NOW);
    const mention = calculateDrivePriority(makeAction({ isAssignment: false }), NOW);
    expect(assignment.score).toBeGreaterThan(mention.score);
  });

  it("gives assignment base score of 140", () => {
    const result = calculateDrivePriority(makeAction({ isAssignment: true, timestamp: OLD }), NOW);
    expect(result.score).toBe(140);
  });

  it("gives mention base score of 100", () => {
    const result = calculateDrivePriority(
      makeAction({ isAssignment: false, commentCount: undefined }),
      NOW
    );
    expect(result.score).toBe(100);
  });

  it("gives unresolved-comment base score of 80 with +15 for 3+ comments", () => {
    const few = calculateDrivePriority(makeAction({ isAssignment: false, commentCount: 2 }), NOW);
    const many = calculateDrivePriority(makeAction({ isAssignment: false, commentCount: 3 }), NOW);
    expect(few.score).toBe(80);
    expect(many.score).toBe(95);
  });

  it("applies +50 recency boost for items < 1 hour old", () => {
    const result = calculateDrivePriority(
      makeAction({ isAssignment: true, timestamp: RECENT }),
      NOW
    );
    expect(result.score).toBe(140 + 50);
    expect(result.category).toBe("critical");
  });

  it("applies +30 recency boost for items < 4 hours old", () => {
    const threeHoursAgo = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const result = calculateDrivePriority(
      makeAction({ isAssignment: true, timestamp: threeHoursAgo }),
      NOW
    );
    expect(result.score).toBe(140 + 30);
  });

  it("applies +10 recency boost for items < 24 hours old", () => {
    const twelveHoursAgo = new Date(NOW.getTime() - 12 * 60 * 60 * 1000).toISOString();
    const result = calculateDrivePriority(
      makeAction({ isAssignment: true, timestamp: twelveHoursAgo }),
      NOW
    );
    expect(result.score).toBe(140 + 10);
  });

  it("applies no recency boost for items > 24 hours old", () => {
    const result = calculateDrivePriority(makeAction({ isAssignment: true, timestamp: OLD }), NOW);
    expect(result.score).toBe(140);
  });
});
