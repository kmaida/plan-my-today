# Data Reference - Quick Lookup

Quick reference for understanding the data returned by `list-all-tasks-today`.

## Response Structure

```typescript
{
  calendar: CalendarEventDetail[],
  linear: LinearIssueDetail[],
  gmail: GmailMessageDetail[],
  meetingSummaries: MeetingSummaryDetail[],
  docs: AssignedActionDetail[],
  github: {
    prs: GitHubPRDetail[],
    issues: GitHubIssueDetail[]
  },
  slack: SlackMessageDetail[],
  metadata: {
    fetched_at: string,  // ISO timestamp
    date: string,        // ISO date
    errors?: string[]    // Auth/API errors
  }
}
```

---

## Priority Thresholds

Defined in [src/constants.ts](../../src/constants.ts):

| Category | Score Range | Constant | Description |
|----------|-------------|----------|-------------|
| **Critical** | ≥180 | `PRIORITY_THRESHOLDS.CRITICAL` | Immediate action needed |
| **High** | 130-179 | `PRIORITY_THRESHOLDS.HIGH` | Important but not urgent |
| **Medium** | 80-129 | `PRIORITY_THRESHOLDS.MEDIUM` | Normal priority |
| **Low** | <80 | (below MEDIUM) | Can defer |

**Usage in agent prompts:**
```
If score ≥ 180 → 🔴 Critical
If score ≥ 130 → 🟡 High
If score ≥ 80 → 🔵 Medium
Else → ⚪ Low
```

---

## Time Windows

Defined in [src/constants.ts](../../src/constants.ts):

| Source | Lookback Window | Constant |
|--------|-----------------|----------|
| **GitHub** (PRs/issues) | 30 days | `TIME_WINDOWS.GITHUB_DAYS` |
| **Gmail** | 14 days | `TIME_WINDOWS.DEFAULT_DAYS_BACK` |
| **Google Docs** | 14 days | `TIME_WINDOWS.DEFAULT_DAYS_BACK` |
| **Slack** | 2 days | `TIME_WINDOWS.SLACK_DAYS_BACK` |
| **Calendar** | Today + future | N/A |
| **Linear** | 14-day due date window | N/A |

**What this means:**
- Items outside these windows won't be returned
- If data seems missing, check if it's beyond the time window
- Time windows balance freshness vs. information overload

---

## Fetch Limits

Defined in [src/constants.ts](../../src/constants.ts):

| Source | Max Items | Constant |
|--------|-----------|----------|
| **Gmail** | 40 messages | `FETCH_LIMITS.GMAIL` |
| **Slack** | 20 messages | `FETCH_LIMITS.SLACK` |
| **Meeting Summaries** | 10 items | `FETCH_LIMITS.MEETINGS` |
| **Calendar** | 20 events | `CALENDAR.MAX_RESULTS` |
| **Linear** | No limit | N/A |
| **GitHub** | No limit | N/A |
| **Google Docs** | No limit | N/A |

**What this means:**
- If user has >40 emails, only the first 40 (by priority) are returned
- If data seems incomplete, limits may be in effect
- Limits prevent overwhelming the agent with too much data

---

## Working Hours Defaults

Defined in [src/constants.ts](../../src/constants.ts):

| Setting | Value | Constant |
|---------|-------|----------|
| **Work start** | 9am | `CALENDAR.WORK_START_HOUR` |
| **Work end** | 5pm | `CALENDAR.WORK_END_HOUR` |
| **Min time block** | 15 minutes | `CALENDAR.MIN_TIME_BLOCK_MINUTES` |

**Usage in agent prompts:**
```
When suggesting time blocks:
- Only suggest between 9am-5pm (unless user specifies otherwise)
- Minimum block size: 15 minutes
- Respect lunch hour (typically 12-1pm, not enforced)
```

---

## Data Type Definitions

Full type definitions: [src/tools/today-todos/types.ts](../../src/tools/today-todos/types.ts)

### Calendar Event

```typescript
interface CalendarEventDetail {
  summary?: string;                    // Meeting title
  start?: { dateTime?: string };       // ISO timestamp
  end?: { dateTime?: string };         // ISO timestamp
  location?: string;                   // Physical location
  hangoutLink?: string;                // Google Meet link
  htmlLink?: string;                   // Google Calendar link
  attendees?: Array<{
    email?: string;
    displayName?: string;
    self?: boolean;                    // True if this is the user
  }>;
  priorityMetadata?: PriorityMetadata;
  meetingContextMetadata?: MeetingContextMetadata;
}
```

**Key fields for planning:**
- `start.dateTime` → Meeting time (parse for time blocking)
- `attendees` → Who's in the meeting
- `hangoutLink` → Video conference link
- `meetingContextMetadata` → Related work items

### Linear Issue

```typescript
interface LinearIssueDetail {
  identifier: string;                  // e.g., "PROJ-123"
  title: string;
  priority: number;                    // 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
  priorityLabel: string;               // "Urgent" | "High" | "Medium" | "Low" | "No priority"
  url: string;                         // Linear issue URL
  state: { name: string; type: string } | null;
  dueDate: string | null;              // ISO date
  estimate: number | null;             // Story points
  project: { name: string } | null;
  completedAt?: string | null;         // ISO timestamp (if completed)
  updatedAt?: string | null;           // ISO timestamp
  priorityMetadata?: PriorityMetadata;
  dependencyMetadata?: DependencyMetadata;
  crossReferenceMetadata?: CrossReferenceMetadata;
}
```

**Key fields for planning:**
- `identifier` → Use for referencing ("work on PROJ-123")
- `dueDate` → Temporal urgency
- `estimate` → Time estimation for time blocking
- `dependencyMetadata` → Blocking relationships
- `completedAt` → Filter completed items for end-of-day reviews

### GitHub PR

```typescript
interface GitHubPRDetail {
  id: number;
  number: number;                      // PR number
  title: string;
  url: string;                         // GitHub URL
  repo: string;                        // "owner/repo"
  type: "assigned" | "review";         // Assigned to you OR review requested
  updatedAt: string;                   // ISO timestamp
  isDraft: boolean;                    // True if still a draft
  priorityMetadata?: PriorityMetadata;
  crossReferenceMetadata?: CrossReferenceMetadata;
}
```

**Key fields for planning:**
- `type` → "review" requests are higher priority
- `isDraft` → Drafts are lower priority (not ready)
- `updatedAt` → Age affects priority score

### GitHub Issue

```typescript
interface GitHubIssueDetail {
  id: number;
  number: number;                      // Issue number
  title: string;
  url: string;                         // GitHub URL
  repo: string;                        // "owner/repo"
  updatedAt: string;                   // ISO timestamp
  labels?: string[];                   // Issue labels
  priorityMetadata?: PriorityMetadata;
  crossReferenceMetadata?: CrossReferenceMetadata;
}
```

### Gmail Message

```typescript
interface GmailMessageDetail {
  id: string;                          // Gmail message ID
  subject: string;
  from: string;                        // Sender email
  link: string;                        // Gmail web URL
  timestamp?: number;                  // Unix timestamp (milliseconds)
  isImportant?: boolean;               // Gmail importance marker
  isStarred?: boolean;                 // User starred
  isFromIndividual?: boolean;          // Not automated (e.g., not noreply@)
  needsReply?: boolean;                // Detected action needed
  hasActionItems?: boolean;            // Detected action keywords
  priorityMetadata?: PriorityMetadata;
}
```

**Key fields for planning:**
- `needsReply` → High priority emails
- `hasActionItems` → Contains "please", "can you", "follow up"
- `isFromIndividual` → Real person vs. automated notification
- `timestamp` → Age for recency scoring

### Slack Message

```typescript
interface SlackMessageDetail {
  text: string;                        // Message text
  timestamp: string;                   // Slack timestamp
  channel: string;                     // Channel ID
  channelName?: string;                // Human-readable name
  user: string;                        // User ID
  userName?: string;                   // Human-readable name
  permalink?: string;                  // Slack message link
  threadTs?: string;                   // Thread identifier
  type: "mention" | "thread" | "dm";   // Message type
  replyCount?: number;                 // For threads
  priorityMetadata?: PriorityMetadata;
}
```

**Key fields for planning:**
- `type` → "mention" = @you, "dm" = direct message, "thread" = thread reply
- `channelName` → Context for where this came from
- `permalink` → Direct link to message

### Meeting Summary

```typescript
interface MeetingSummaryDetail {
  platform: "zoom" | "google-meet" | "teams" | "other";
  meetingTitle: string | null;         // Extracted from subject
  subject: string;                     // Email subject
  timestamp: number;                   // Unix timestamp (milliseconds)
  hasActionItems: boolean;             // Detected action items
  snippet: string;                     // Email preview
  link: string;                        // Gmail link
  recordingLink: string | null;        // Link to recording
  from: string;                        // Sender (e.g., no-reply@zoom.us)
  priorityMetadata?: PriorityMetadata;
}
```

**Key fields for planning:**
- `hasActionItems` → Meeting had action items
- `recordingLink` → Link to recording for review
- `meetingTitle` → Match against calendar events

### Google Docs Action

```typescript
interface AssignedActionDetail {
  fileTitle: string;                   // Document title
  actionType: string;                  // "assigned" | "mentioned"
  fileLink: string | null;             // Google Docs URL
  timestamp?: string;                  // ISO timestamp
  isAssignment?: boolean;              // True if assigned, false if just mentioned
  priorityMetadata?: PriorityMetadata;
}
```

**Key fields for planning:**
- `isAssignment` → Assigned actions are higher priority than mentions
- `fileTitle` → Document name for context

---

## Metadata Structures

### Priority Metadata

Available on: **All items**

```typescript
interface PriorityMetadata {
  score: number;        // 0-300 (higher = more urgent)
  category: string;     // "critical" | "high" | "medium" | "low"
  signals: object;      // Type-specific (varies by source)
  reasons: string[];    // Human-readable explanations
}
```

**Example signals by source:**
- Calendar: `proximity`, `hasConferenceLink`
- Linear: `dueToday`, `daysUntilDue`, `temporalUrgency`, `hasEstimate`
- GitHub: `ageHours`, `isReviewRequest`, `isDraft`
- Gmail: `ageHours`, `isImportant`, `needsReply`, `hasActionItems`, `isFromIndividual`
- Slack: `ageHours`, `isMention`, `isDM`, `inThread`

### Dependency Metadata

Available on: **Linear issues only**

```typescript
interface DependencyMetadata {
  blockedBy: string[];        // Issue IDs blocking this item
  blocks: string[];           // Issue IDs this item blocks
  waitingOn: string[];        // People/emails we're waiting on
  blockedByExternal: boolean; // True if blocked by external factor
}
```

### Cross-Reference Metadata

Available on: **Linear issues and GitHub items**

```typescript
interface CrossReferenceMetadata {
  mentionedIn: string[];      // ["linear", "email", "slack"]
  relatedItems: Array<{
    source: string;           // "email" | "slack"
    id: string;
    snippet: string;          // Truncated to 100 chars
  }>;
  totalMentions: number;      // ≥1 (includes origin)
}
```

### Meeting Context Metadata

Available on: **Calendar events only**

```typescript
interface MeetingContextMetadata {
  relatedIssues: Array<{
    identifier: string;
    title: string;
    reason: string;          // "keyword_match" | "project_match" | "attendee_match"
  }>;
  relatedPRs: Array<{
    number: number;
    repo: string;
    title: string;
    reason: string;
  }>;
  relatedEmails: Array<{
    id: string;
    subject: string;
    from: string;
    reason: string;          // "attendee_needs_reply" | "topic_match"
  }>;
  attendeeContext: Array<{
    email: string;
    pendingItems: number;
  }>;
  hasSummary: boolean;
  summaryLink?: string;
}
```

---

## Priority Scoring Details

### Calendar Events (Proximity-Based)

| Proximity | Score | Condition |
|-----------|-------|-----------|
| Happening now | 300 | Event is currently active |
| Very soon | 250 | Starts within 15 minutes |
| Upcoming | 200 | Starts within 1 hour |
| Later today | 150 | Starts later today |
| Future | 100 | Starts tomorrow or later |

### Linear Issues

**Base score:** 70

**Temporal urgency modifiers:**
- Overdue: +100
- Due today: +80
- Due this week: +40
- No due date: +0

**Priority level modifiers:**
- Urgent (priority=1): +50
- High (priority=2): +30
- Medium (priority=3): +10
- Low (priority=4): +0

**Recency bonus:**
- Updated in last 24 hours: +20

**Example calculation:**
```
PROJ-123:
- Base: 70
- Due today: +80
- Urgent priority: +50
- Total: 200 (critical)
```

### GitHub PRs

**Base score:** 50

**Type modifiers:**
- Review requested: +100
- Assigned PR: +60
- Draft PR: -30

**Age bonus:**
- ≤4 hours: +40
- ≤24 hours: +20
- ≤7 days: +10

**Example calculation:**
```
PR #456 (review, 3 hours old):
- Base: 50
- Review: +100
- Age: +40
- Total: 190 (critical)
```

### Gmail Messages

**Base score:** 60

**Modifier flags:**
- Important: +50
- Starred: +30
- Needs reply: +40
- Has action items: +30
- From individual: +20

**Recency decay:** Varies by age

### Slack Messages

**Type base scores:**
- Mention (@you): 120
- DM: 100
- Thread: 80

**Age bonus:**
- ≤4 hours: +40
- ≤24 hours: +20

---

## Error Handling

If `metadata.errors` exists, it contains auth/API error messages:

```json
{
  "metadata": {
    "fetched_at": "2026-01-27T12:00:00Z",
    "date": "2026-01-27",
    "errors": [
      "Gmail: Authentication failed - token expired",
      "Slack: Not connected"
    ]
  }
}
```

**Agent should:**
1. Acknowledge partial data: "I found tasks but couldn't fetch from Gmail and Slack due to auth issues"
2. Suggest fix: "Visit /auth to reconnect these sources"
3. Proceed with available data

---

## Common Patterns

### Filtering Completed Linear Issues

```typescript
const pendingIssues = linear.filter(issue => !issue.completedAt);
const completedToday = linear.filter(issue =>
  issue.completedAt && isToday(issue.completedAt)
);
```

### Finding Unblocking Tasks

```typescript
const unblockingTasks = linear.filter(issue =>
  issue.dependencyMetadata?.blocks?.length > 0
);
```

### High-Visibility Items

```typescript
const highVisibility = [...linear, ...github.prs, ...github.issues].filter(item =>
  item.crossReferenceMetadata?.totalMentions > 2
);
```

### Meeting Prep Items

```typescript
const upcomingMeetings = calendar.filter(event => {
  const startTime = new Date(event.start.dateTime);
  const now = new Date();
  return startTime > now && startTime < addHours(now, 2);
});
```

---

## Quick Tips

1. **Always sort by `priorityMetadata.score`** (descending) for priority lists
2. **Check `dependencyMetadata.blocks`** to find unblocking tasks
3. **Use `crossReferenceMetadata.totalMentions`** as an importance signal
4. **Parse `meetingContextMetadata`** for meeting prep
5. **Filter `completedAt`** to separate pending from completed Linear issues
6. **Check `isDraft`** to deprioritize GitHub draft PRs
7. **Use `needsReply` and `hasActionItems`** to triage emails
8. **Group by `type`** for Slack messages (mentions vs. threads vs. DMs)

---

## Resources

- [Type Definitions](../../src/tools/today-todos/types.ts)
- [Constants](../../src/constants.ts)
- [Metadata Guide](./metadata-guide.md)
- [System Prompt](./system-prompt.md)
