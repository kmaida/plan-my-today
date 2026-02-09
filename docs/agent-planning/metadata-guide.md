# Metadata Usage Guide

Comprehensive guide to understanding and using the enriched metadata from `list-all-tasks-today`.

## Overview

The todo-mcp-server enriches every item with metadata to help agents make intelligent planning decisions. This guide explains each metadata type with examples and best practices.

## Metadata Types

1. **Priority Metadata** - Urgency scoring (0-300 scale)
2. **Dependency Metadata** - Blocking relationships (Linear only)
3. **Cross-Reference Metadata** - Mentions across sources (Linear & GitHub)
4. **Meeting Context Metadata** - Related work items (Calendar only)

---

## 1. Priority Metadata

Every item (calendar events, Linear issues, GitHub PRs, emails, Slack messages, etc.) has a `priorityMetadata` object.

### Structure

```typescript
interface PriorityMetadata {
  score: number;        // 0-300 (higher = more urgent)
  category: string;     // "critical" | "high" | "medium" | "low"
  signals: object;      // Type-specific signals (varies by source)
  reasons: string[];    // Human-readable explanations
}
```

### Categories & Thresholds

| Category | Score Range | Meaning | Visual |
|----------|-------------|---------|--------|
| **Critical** | ≥180 | Immediate action needed | 🔴 |
| **High** | 130-179 | Important but not urgent | 🟡 |
| **Medium** | 80-129 | Normal priority | 🔵 |
| **Low** | <80 | Can defer | ⚪ |

### Examples by Source

#### Calendar Event (Meeting)

```json
{
  "summary": "Team Sync",
  "start": { "dateTime": "2026-01-27T09:00:00-08:00" },
  "priorityMetadata": {
    "score": 250,
    "category": "critical",
    "signals": {
      "proximity": "happening_now",
      "hasConferenceLink": true
    },
    "reasons": [
      "Happening now",
      "Has conference link (likely important meeting)"
    ]
  }
}
```

**Agent interpretation:**
```
🔴 CRITICAL: Team Sync at 9:00 AM (score: 250) - Happening now
```

**Scoring logic:**
- `happening_now`: 300 (meeting is active)
- `very_soon` (within 15 min): 250
- `upcoming` (within 1 hour): 200
- `later_today`: 150
- `future`: 100

#### Linear Issue

```json
{
  "identifier": "PROJ-123",
  "title": "Fix authentication bug",
  "dueDate": "2026-01-27",
  "priority": 1,
  "priorityLabel": "Urgent",
  "priorityMetadata": {
    "score": 215,
    "category": "critical",
    "signals": {
      "dueToday": true,
      "hasEstimate": true,
      "daysUntilDue": 0,
      "temporalUrgency": 80
    },
    "reasons": [
      "Due today",
      "High priority (Urgent)",
      "Project: Launch"
    ]
  }
}
```

**Agent interpretation:**
```
🔴 CRITICAL: PROJ-123 (score: 215) - Due today, Urgent priority for Launch project
```

**Scoring logic:**
- Base score: 70
- Temporal urgency: +80 (due today), +40 (due this week), +100 (overdue)
- Priority level: +50 (urgent), +30 (high), +10 (medium)
- Recent activity: +30 (≤24h), +20 (≤3 days), +10 (≤7 days)
- Has estimate: signal for planning

#### Linear Issue (No Due Date, But Recently Active)

```json
{
  "identifier": "PROJ-456",
  "title": "Implement new feature",
  "dueDate": null,
  "priority": 2,
  "priorityLabel": "High",
  "updatedAt": "2026-01-27T10:00:00Z",
  "priorityMetadata": {
    "score": 130,
    "category": "high",
    "signals": {
      "temporalUrgency": "no_due_date",
      "priorityLevel": 2,
      "daysUntilDue": null,
      "hasEstimate": true,
      "ageHours": 2,
      "recentlyUpdated": true
    },
    "reasons": [
      "High priority",
      "Updated in last 24 hours"
    ]
  }
}
```

**Agent interpretation:**
```
🟡 HIGH PRIORITY: PROJ-456 (score: 130) - High priority, active work (updated 2 hours ago)
```

**Why this matters:**
Even without a due date, this issue gets high priority because:
- It has "High" priority in Linear (+30)
- It was updated 2 hours ago (+30 for recent activity)
- Total score: 130 (high priority category)

**This surfaces actively worked items that might otherwise be hidden!**

**Scoring breakdown:**
- Base: 70
- No due date: +0
- High priority: +30
- Updated 2 hours ago: +30
- **Total: 130** (high priority)

#### GitHub PR (Review Requested)

```json
{
  "number": 456,
  "title": "Add new API endpoint",
  "type": "review",
  "updatedAt": "2026-01-27T06:00:00Z",
  "isDraft": false,
  "priorityMetadata": {
    "score": 170,
    "category": "high",
    "signals": {
      "ageHours": 3,
      "isReviewRequest": true,
      "isDraft": false
    },
    "reasons": [
      "Review requested",
      "Updated 3 hours ago",
      "Not a draft (ready for review)"
    ]
  }
}
```

**Agent interpretation:**
```
🟡 HIGH PRIORITY: PR #456 (score: 170) - Review requested 3 hours ago, ready to merge
```

**Scoring logic:**
- Base score: 50
- Review requested: +100
- Assigned PR: +60
- Draft PR: -30
- Age boost: +40 (≤4 hours), +20 (≤24 hours), +10 (≤7 days)

#### Gmail Message

```json
{
  "id": "abc123",
  "subject": "Q1 Planning - Action Required",
  "from": "jane@company.com",
  "timestamp": 1738000000000,
  "isImportant": true,
  "isStarred": false,
  "isFromIndividual": true,
  "needsReply": true,
  "hasActionItems": true,
  "priorityMetadata": {
    "score": 155,
    "category": "high",
    "signals": {
      "ageHours": 48,
      "isImportant": true,
      "needsReply": true,
      "hasActionItems": true,
      "isFromIndividual": true
    },
    "reasons": [
      "Marked important",
      "Needs action",
      "Has action items",
      "From individual (not automated)"
    ]
  }
}
```

**Agent interpretation:**
```
🟡 HIGH PRIORITY: Email from Jane (score: 155) - Action required, needs action, 2 days old
```

**Scoring logic:**
- Base score: 60
- Marked important: +50
- Starred: +30
- Needs action: +40
- Has action items: +30
- From individual: +20
- Recency boost: varies by age

#### Slack Message

```json
{
  "text": "@you can you review PROJ-123 before deploy?",
  "type": "mention",
  "channelName": "engineering",
  "timestamp": "1738015200.000000",
  "priorityMetadata": {
    "score": 140,
    "category": "high",
    "signals": {
      "ageHours": 4,
      "isMention": true,
      "isDM": false,
      "inThread": false
    },
    "reasons": [
      "You were mentioned",
      "Posted 4 hours ago",
      "In #engineering channel"
    ]
  }
}
```

**Agent interpretation:**
```
🟡 HIGH PRIORITY: Slack mention in #engineering (score: 140) - Review requested 4 hours ago
```

**Scoring logic:**
- Mention (@you): 120 base
- Thread reply: 80 base
- DM: 100 base
- Recency boost: +40 (≤4 hours), +20 (≤24 hours)

### How Agents Should Use Priority Metadata

1. **Sort by score** when showing lists (highest first)
2. **Use category** for visual grouping and color coding
3. **Show reasons** to explain why something is urgent
4. **Use signals** for additional context in explanations

**Example agent response:**
```markdown
## Top Priorities

🔴 **PROJ-123: Fix auth bug** (critical, score: 215)
- Due today
- Urgent priority
- Part of Launch project

🟡 **PR #456: Add API endpoint** (high, score: 170)
- Review requested 3 hours ago
- Not a draft, ready to merge

🟡 **Email from Jane** (high, score: 155)
- Action required
- Needs action (2 days old)
```

---

## 2. Dependency Metadata

Linear issues have `dependencyMetadata` that describes blocking relationships.

### Structure

```typescript
interface DependencyMetadata {
  blockedBy: string[];        // Issue IDs blocking this item
  blocks: string[];           // Issue IDs this item blocks (reverse lookup)
  waitingOn: string[];        // People/emails we're waiting on
  blockedByExternal: boolean; // True if blocked by person/external factor
}
```

### How Dependencies Are Detected

The server parses Linear issue titles and descriptions for patterns like:
- "blocked by ABC-123"
- "depends on #456"
- "after PROJ-789"
- "requires XYZ-234"
- "waiting on user@email.com"
- "blocked by design team"

### Example 1: Unblocking Task

```json
{
  "identifier": "PROJ-100",
  "title": "Design API schema",
  "dependencyMetadata": {
    "blockedBy": [],
    "blocks": ["PROJ-123", "PROJ-124", "PROJ-125"],
    "waitingOn": [],
    "blockedByExternal": false
  }
}
```

**Agent interpretation:**
```
⚡ HIGH PRIORITY: PROJ-100 (Unblocking Task)
- Completing this unblocks 3 downstream tasks: PROJ-123, PROJ-124, PROJ-125
- No blockers, can start immediately
- Recommendation: Prioritize this to enable parallel work on dependent tasks
```

### Example 2: Blocked Task

```json
{
  "identifier": "PROJ-123",
  "title": "Implement API endpoint (blocked by PROJ-100)",
  "dependencyMetadata": {
    "blockedBy": ["PROJ-100"],
    "blocks": [],
    "waitingOn": [],
    "blockedByExternal": false
  }
}
```

**Agent interpretation:**
```
⏸️ BLOCKED: PROJ-123
- Blocked by PROJ-100 (Design API schema)
- Cannot start until PROJ-100 is completed
- Recommendation: Deprioritize until blocker is resolved, work on other items
```

### Example 3: External Blocker

```json
{
  "identifier": "PROJ-456",
  "title": "Deploy feature (waiting on security@company.com)",
  "dependencyMetadata": {
    "blockedBy": [],
    "blocks": [],
    "waitingOn": ["security@company.com"],
    "blockedByExternal": true
  }
}
```

**Agent interpretation:**
```
⏳ WAITING ON EXTERNAL: PROJ-456
- Waiting on security@company.com
- Recommendation: Follow up with security team for update
- Consider working on other items while waiting
```

### How Agents Should Use Dependency Metadata

1. **Prioritize unblocking tasks** - Items with non-empty `blocks` array should be high priority
2. **Deprioritize blocked tasks** - Items with non-empty `blockedBy` array cannot start yet
3. **Surface follow-ups** - Items with non-empty `waitingOn` array need human action
4. **Build dependency graphs** - Visualize blocking relationships when asked

**Example agent response:**
```markdown
## Dependency Analysis

### Unblocking Tasks (Prioritize These)
1. **PROJ-100** - Unblocks 3 tasks (PROJ-123, PROJ-124, PROJ-125)
2. **PROJ-200** - Unblocks 1 task (PROJ-201)

### Blocked Tasks (Cannot Start)
- **PROJ-123** - Blocked by PROJ-100
- **PROJ-124** - Blocked by PROJ-100
- **PROJ-125** - Blocked by PROJ-100

### Waiting on External (Follow Up)
- **PROJ-456** - Waiting on security@company.com (suggest: ping for update)
```

---

## 3. Cross-Reference Metadata

Linear issues and GitHub items have `crossReferenceMetadata` when mentioned in emails or Slack.

### Structure

```typescript
interface CrossReferenceMetadata {
  mentionedIn: string[];      // Sources: ["linear", "email", "slack"]
  relatedItems: Array<{
    source: string;           // "email" | "slack"
    id: string;              // Item ID from that source
    snippet: string;         // Context (truncated to 100 chars)
  }>;
  totalMentions: number;      // Count including origin (≥1)
}
```

### How Cross-References Are Detected

The server searches email subjects/bodies and Slack messages for:
- Linear issue IDs (e.g., "PROJ-123", "ABC-456")
- GitHub patterns (e.g., "#123", "owner/repo#456", github.com URLs)

### Example: High-Mention Item

```json
{
  "identifier": "PROJ-123",
  "title": "Fix authentication bug",
  "crossReferenceMetadata": {
    "mentionedIn": ["linear", "email", "email", "slack"],
    "relatedItems": [
      {
        "source": "email",
        "id": "abc123",
        "snippet": "Can you look at PROJ-123 when you get a chance? Customers are reporting issues..."
      },
      {
        "source": "email",
        "id": "def456",
        "snippet": "Following up on PROJ-123 - any ETA?"
      },
      {
        "source": "slack",
        "id": "msg789",
        "snippet": "@you need to review PROJ-123 before deploy"
      }
    ],
    "totalMentions": 4
  }
}
```

**Agent interpretation:**
```
📣 HIGH VISIBILITY: PROJ-123 (mentioned 4 times)

**Context across sources:**
- 📧 Email from jane@company.com: "Can you look at PROJ-123 when you get a chance? Customers are..."
- 📧 Email from bob@company.com: "Following up on PROJ-123 - any ETA?"
- 💬 Slack #engineering: "@you need to review PROJ-123 before deploy"

**Why this matters:** Multiple people asking about this, customers impacted, deployment blocker
**Recommendation:** High priority due to visibility and customer impact
```

### Example: Single Source (No Cross-References)

```json
{
  "identifier": "PROJ-789",
  "title": "Refactor utility functions",
  "crossReferenceMetadata": {
    "mentionedIn": ["linear"],
    "relatedItems": [],
    "totalMentions": 1
  }
}
```

**Agent interpretation:**
```
PROJ-789: Refactor utility functions
- Only mentioned in Linear (no cross-references)
- Lower visibility, can be scheduled flexibly
```

### How Agents Should Use Cross-Reference Metadata

1. **Prioritize high-mention items** - `totalMentions > 2` indicates visibility and importance
2. **Show context snippets** - Help user understand why item is mentioned
3. **Group related work** - Items mentioned together may be related
4. **Flag communication needs** - If mentioned in Slack/email, user may need to respond

**Example agent response:**
```markdown
## High-Signal Work (Mentioned Multiple Times)

### 📣 PROJ-123: Fix authentication bug (4 mentions)
- Jane (email): "Can you look at PROJ-123..."
- Bob (email): "Following up on PROJ-123..."
- #engineering (Slack): "Review PROJ-123 before deploy"
→ **High priority:** Customer-facing, multiple stakeholders waiting

### 📣 PR #456: Add API endpoint (2 mentions)
- #api-team (Slack): "Need PR #456 merged for launch"
→ **Launch dependency:** Team is waiting
```

---

## 4. Meeting Context Metadata

Calendar events have `meetingContextMetadata` that cross-references with work items.

### Structure

```typescript
interface MeetingContextMetadata {
  relatedIssues: Array<{
    identifier: string;       // Linear issue ID
    title: string;
    reason: string;           // "keyword_match" | "project_match" | "attendee_match"
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
    reason: string;           // "attendee_needs_action" | "topic_match"
  }>;
  attendeeContext: Array<{
    email: string;
    pendingItems: number;     // Count of items involving this person
  }>;
  hasSummary: boolean;
  summaryLink?: string;
}
```

### How Meeting Context Is Generated

The server:
1. Extracts keywords from meeting title (e.g., "Messaging Framework" → ["messaging", "framework"])
2. Matches against Linear issues and GitHub PRs (≥2 keyword matches)
3. Finds emails from attendees that need replies
4. Counts pending items per attendee
5. Links to meeting recordings/summaries if available

### Example: Well-Prepared Meeting

```json
{
  "summary": "Messaging Framework Sync",
  "start": { "dateTime": "2026-01-27T10:00:00-08:00" },
  "attendees": [
    { "email": "jane@company.com", "displayName": "Jane Doe" },
    { "email": "bob@company.com", "displayName": "Bob Smith" }
  ],
  "meetingContextMetadata": {
    "relatedIssues": [
      {
        "identifier": "PROJ-123",
        "title": "Fix messaging framework v0.1 deployment",
        "reason": "keyword_match"
      },
      {
        "identifier": "PROJ-200",
        "title": "Update messaging docs for framework",
        "reason": "keyword_match"
      }
    ],
    "relatedPRs": [
      {
        "number": 456,
        "repo": "company/backend",
        "title": "Add messaging framework tests",
        "reason": "keyword_match"
      }
    ],
    "relatedEmails": [
      {
        "id": "email123",
        "subject": "Re: Messaging Framework Questions",
        "from": "jane@company.com",
        "reason": "attendee_needs_action"
      }
    ],
    "attendeeContext": [
      { "email": "jane@company.com", "pendingItems": 2 },
      { "email": "bob@company.com", "pendingItems": 1 }
    ],
    "hasSummary": true,
    "summaryLink": "https://zoom.us/rec/share/abc123"
  }
}
```

**Agent interpretation:**
```markdown
📅 **Messaging Framework Sync** (10:00 AM - 11:00 AM)

**Issues to Review:**
- PROJ-123: Fix messaging framework v0.1 deployment (keyword match: messaging, framework)
- PROJ-200: Update messaging docs for framework (keyword match: messaging, framework)

**PRs to Review:**
- PR #456 (company/backend): Add messaging framework tests (keyword match)

**Emails Needing Action:**
- "Re: Messaging Framework Questions" from jane@company.com (needs action)

**Attendee Context:**
- jane@company.com: 2 pending items
- bob@company.com: 1 pending item

**Previous Meeting:**
- [View Recording](https://zoom.us/rec/share/abc123) from last sync

**Recommendation:** Review PROJ-123 and PR #456 before meeting, reply to Jane's email
```

### Example: Meeting with No Context

```json
{
  "summary": "1:1 with Jane",
  "start": { "dateTime": "2026-01-27T14:00:00-08:00" },
  "meetingContextMetadata": {
    "relatedIssues": [],
    "relatedPRs": [],
    "relatedEmails": [],
    "attendeeContext": [
      { "email": "jane@company.com", "pendingItems": 2 }
    ],
    "hasSummary": false
  }
}
```

**Agent interpretation:**
```markdown
📅 **1:1 with Jane** (2:00 PM - 3:00 PM)

**Attendee Context:**
- jane@company.com has 2 pending items

**No specific work items matched to this meeting**
(Generic meeting title, no keyword matches found)

**Recommendation:** Review Jane's pending items generally before the 1:1
```

### How Agents Should Use Meeting Context Metadata

1. **Prepare for meetings** - Show all related work items to review beforehand
2. **Flag email follow-ups** - Remind user to reply to attendees
3. **Provide attendee context** - Show what each person is working on
4. **Link to recordings** - Help user review previous discussions

**Example agent response:**
```markdown
## Meeting Preparation

### 10:00 AM - Messaging Framework Sync

**Prep checklist:**
- [ ] Review PROJ-123 (deployment issue)
- [ ] Review PROJ-200 (docs update)
- [ ] Review PR #456 (tests)
- [ ] Reply to Jane's email about framework questions

**Attendees:**
- Jane (2 pending items) - likely to discuss PROJ-123, PROJ-200
- Bob (1 pending item) - may discuss PR #456

**Previous context:** [Recording from last sync](https://zoom.us/rec/...)

**Estimated prep time:** 20 minutes
```

---

## Best Practices for Agents

### 1. Always Explain Reasoning

Use metadata to justify recommendations:

❌ **Bad:**
```
You should work on PROJ-123 next.
```

✅ **Good:**
```
You should work on PROJ-123 next (score: 215, critical priority).

Reasoning:
- Due today (temporal urgency)
- Marked Urgent in Linear
- Mentioned 4 times across email and Slack
- Unblocks 3 downstream tasks (PROJ-124, PROJ-125, PROJ-126)
```

### 2. Group Related Work

Use cross-references and keywords to cluster:

```markdown
## Messaging Framework Work (grouped)

- PROJ-123: Fix deployment (critical, score: 215)
- PROJ-200: Update docs (high, score: 140)
- PR #456: Add tests (high, score: 170)
- Meeting at 10am: Messaging Framework Sync

**Why grouped:** All related to the same project, efficient to work on together
```

### 3. Surface Forgotten Items

Look for signals like:
- Old `timestamp` (emails starred >3 days ago)
- `needsReply: true` (emails awaiting response)
- `type: "dm"` in Slack (direct messages may be overlooked)
- Meeting summaries with `hasActionItems: true`

### 4. Adapt to User Feedback

If user says "too detailed", simplify:
```
Top 3 priorities:
1. PROJ-123 (critical, due today, unblocks 3 tasks)
2. PR #456 (high, review requested)
3. Reply to 2 emails (high, action required)
```

If user says "explain more", expand with full metadata.

---

## Quick Reference

| Metadata Type | Available On | Primary Use |
|---------------|--------------|-------------|
| Priority | All items | Sorting, categorization, urgency |
| Dependency | Linear issues | Identifying blockers, unblocking tasks |
| Cross-Reference | Linear, GitHub | Grouping related work, visibility signals |
| Meeting Context | Calendar events | Meeting prep, attendee context |

---

## Next Steps

1. Review [data-reference.md](./data-reference.md) for thresholds and constants
2. Test metadata interpretation with [example-prompts.md](./example-prompts.md)
3. Customize the [system-prompt.md](./system-prompt.md) for your workflow

## Resources

- [Priority Scoring Logic](../src/tools/today-todos/priority-utils.ts)
- [Dependency Parsing](../src/tools/today-todos/dependency-utils.ts)
- [Cross-Reference Detection](../src/tools/today-todos/cross-reference-utils.ts)
- [Meeting Context Generation](../src/tools/today-todos/meeting-prep-utils.ts)
