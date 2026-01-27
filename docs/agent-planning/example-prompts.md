# Example Prompts for Daily Planning

Pre-written prompts you can use with your planning agent. Copy and paste these directly into Claude Desktop.

## Quick Reference

| Workflow | Prompt |
|----------|--------|
| Morning briefing | "Plan my day" |
| What's next | "What should I work on next?" |
| Meeting prep | "Prep me for meetings" |
| Dependency analysis | "What's blocking work?" |
| Cross-source context | "What items are mentioned multiple times?" |
| End-of-day review | "Review my day" |
| Focus time | "I have 2 hours free, what should I work on?" |

---

## Morning Briefing

### Comprehensive Daily Plan

```
Please analyze my tasks for today and create a comprehensive plan including:
1. Top 3-5 priorities with reasoning
2. Time-blocked schedule for available slots
3. Meeting preparation context
4. Any blockers or forgotten items
```

**What you'll get:**
- Executive summary of the day
- Time blocks with suggested tasks
- Meeting prep for each calendar event
- Dependency analysis
- Items that might be overlooked

### Quick Morning Briefing

```
Plan my day
```

**What you'll get:**
- Concise daily plan following the system prompt format

### Morning Briefing with Focus

```
Plan my day with a focus on unblocking other work. Show me which tasks would have the highest impact.
```

**What you'll get:**
- Daily plan prioritizing tasks that unblock downstream work

---

## On-Demand Planning

### What's Next

```
What should I work on next?
```

**What you'll get:**
- 1-2 immediate recommendations
- Reasoning based on priorities and dependencies

### Focus Time Planning

```
I have 2 hours of focus time right now. What should I work on?
Consider priorities, dependencies, and related work.
```

**What you'll get:**
- Tasks suitable for a 2-hour block
- Grouped by topic for context efficiency

### Quick Win

```
I have 30 minutes before my next meeting. What's a quick win I can accomplish?
```

**What you'll get:**
- Short tasks (small estimates or email replies)
- High-impact items that fit the timeframe

### Between Meetings

```
I have 1 hour between meetings. What should I focus on?
```

**What you'll get:**
- Tasks suitable for the available time
- Preference for related work to minimize context switching

---

## Dependency Analysis

### What's Blocking Work

```
What items are blocking other work? Help me prioritize tasks that would
unblock downstream work, and show me what's currently blocked.
```

**What you'll get:**
- Unblocking tasks (high priority)
- Blocked tasks (explain what's waiting)
- Follow-ups needed (external dependencies)

### Dependency Graph

```
Show me the dependency relationships in my Linear issues. Which items should I prioritize to unblock the most work?
```

**What you'll get:**
- Visual or list-based dependency graph
- Tasks sorted by how much work they unblock

### External Dependencies

```
What items are waiting on other people? Help me identify follow-ups I should send.
```

**What you'll get:**
- Items with `waitingOn` metadata
- Suggested follow-up actions

---

## Meeting Preparation

### Prep for All Meetings

```
I have meetings today. What issues, PRs, and emails should I review beforehand?
Show me context for each meeting.
```

**What you'll get:**
- For each meeting:
  - Related Linear issues
  - Related GitHub PRs
  - Emails from attendees needing replies
  - Pending items per attendee
  - Links to previous recordings

### Prep for Specific Meeting

```
I have "Team Sync" in 30 minutes. What should I review?
```

**What you'll get:**
- Context specific to that meeting
- Related work items
- Attendee context

### Meeting-Focused Day

```
I have a meeting-heavy day. For each meeting, show me:
1. What to review beforehand
2. Topics to bring up based on my pending work
3. Follow-ups I owe attendees
```

**What you'll get:**
- Detailed prep for each calendar event
- Suggested talking points
- Action items to discuss

---

## Cross-Source Context

### High-Signal Work

```
What items are mentioned across multiple sources (email, Slack, Linear)?
Show me high-signal work that's being discussed in multiple places.
```

**What you'll get:**
- Items with `totalMentions > 1`
- Context from each source
- Why these items are getting attention

### Slack Mentions

```
What Linear issues or GitHub PRs are people mentioning in Slack?
```

**What you'll get:**
- Work items mentioned in Slack messages
- Snippets showing context
- Who is asking about what

### Email Context

```
What work items are mentioned in my emails? Show me which issues or PRs people are asking about.
```

**What you'll get:**
- Work items referenced in Gmail
- Email context and senders
- Items needing responses

---

## End-of-Day Review

### Daily Review

```
Review my day and plan for tomorrow. What did I complete? What's still pending?
What should be my top priorities for tomorrow morning?
```

**What you'll get:**
- Completed items (from Linear `completedAt`, closed PRs)
- Pending high-priority items
- Tomorrow's top 3-5 priorities

### Week-End Review

```
It's Friday. Review my week and help me plan for Monday. What loose ends should I tie up before EOD?
```

**What you'll get:**
- Week summary
- Items to wrap up today
- Monday priorities

### Context Switching Prep

```
I'm about to switch contexts (going home / end of workday). What should I document or follow up on before I leave?
```

**What you'll get:**
- Open threads to close
- Follow-ups to send
- Items to document for tomorrow

---

## Specialized Queries

### GitHub PR Review Focus

```
Show me all GitHub PRs that need my review. Prioritize by how long they've been waiting and their importance.
```

**What you'll get:**
- PRs with `type: "review"`
- Sorted by age and priority score
- Context if mentioned in Slack or email

### Email Triage

```
Help me triage my emails. Which ones need replies? Which are action items?
Prioritize by sender and urgency.
```

**What you'll get:**
- Emails with `needsReply: true` or `hasActionItems: true`
- Prioritized by importance signals
- Suggested actions

### Slack Response Planning

```
Show me my Slack mentions and DMs. Which ones need responses?
What's the context for each?
```

**What you'll get:**
- Slack messages by type (mention, thread, DM)
- Context and priority
- Suggested response order

### Linear Sprint Planning

```
Show me my Linear issues due this week. Group them by project and priority.
Which ones are blocked? Which ones block other work?
```

**What you'll get:**
- Linear issues due this week
- Grouped by project
- Dependency information

### Forgotten Items

```
What might I have forgotten? Check for:
- Emails I starred days ago
- Slack mentions I haven't responded to
- Action items from recent meetings
```

**What you'll get:**
- Old starred emails
- Unresponded Slack messages
- Meeting action items from summaries

---

## Custom Time Blocks

### Morning Deep Work

```
It's morning and I want to do deep work. What code-related tasks should I prioritize?
Avoid meetings, emails, and Slack for now.
```

**What you'll get:**
- Linear issues and GitHub PRs
- Focused on coding tasks
- Grouped by project/topic

### Afternoon Collaboration

```
It's afternoon and I'm in collaboration mode. What meetings, emails, and Slack messages should I focus on?
```

**What you'll get:**
- Meeting prep
- Email responses
- Slack triage

### Friday Wrap-Up

```
It's Friday afternoon. Help me wrap up the week:
1. What loose ends should I tie up?
2. What can wait until Monday?
3. What should I document before leaving?
```

**What you'll get:**
- Must-finish items
- Monday priorities
- Documentation reminders

---

## Advanced Queries

### Impact Analysis

```
If I complete PROJ-123 right now, what downstream work would that enable?
Show me the impact of unblocking this task.
```

**What you'll get:**
- Tasks that `PROJ-123` blocks
- Estimated impact on other work

### Theme Detection

```
Looking at my Linear issues, GitHub PRs, and meetings - what themes or projects
are dominating my work this week?
```

**What you'll get:**
- Common projects or keywords
- Grouped work by theme
- Suggested focus areas

### Urgency Check

```
What's the most urgent thing right now? Look across all sources and tell me
what needs immediate attention.
```

**What you'll get:**
- Highest priority item (by score)
- Reasoning from `priorityMetadata.reasons`
- Context from all sources

### Balance Check

```
How balanced is my workload today? Am I spending too much time in meetings
vs. focus work? Do I have time for proactive work?
```

**What you'll get:**
- Calendar analysis (meeting vs. focus time)
- Breakdown of reactive vs. proactive work
- Suggestions for better balance

---

## Feedback & Iteration

### Too Detailed

```
That's too detailed. Just give me the top 3 priorities and time blocks.
```

**Claude will adapt** to give a more concise response.

### Too Brief

```
That's too brief. Give me detailed reasoning for each priority, including
all the metadata signals you used.
```

**Claude will expand** with more detail and explanations.

### Reprioritize

```
Actually, I want to focus on PROJ-123 today. Replan my day around that
as the top priority.
```

**Claude will adjust** the plan with your focus item prioritized.

### Change Time Block

```
I don't have 2 hours for that block, I only have 1 hour. What fits in 1 hour?
```

**Claude will re-suggest** tasks for the shorter timeframe.

---

## Tips for Effective Prompts

### Be Specific About Time

Good:
```
I have 1 hour before lunch. What should I work on?
```

Better:
```
I have 1 hour before lunch (11am-12pm). What should I work on?
Consider that I have a meeting right after lunch.
```

### Specify Your Context

Good:
```
Plan my day
```

Better:
```
Plan my day. I'm in a maker mindset and want to focus on coding.
Deprioritize meetings and emails for now.
```

### Ask for Reasoning

Good:
```
What should I work on next?
```

Better:
```
What should I work on next? Explain your reasoning using the
priority metadata and dependency information.
```

### Give Feedback

After a response:
```
Perfect! That's exactly what I needed.
```

Or:
```
That's too focused on emails. I want to prioritize coding tasks.
```

Claude will remember your preferences within the conversation.

---

## Combining Prompts

You can combine multiple aspects:

```
Plan my day with these preferences:
1. Prioritize tasks that unblock other work
2. Group related work together
3. Show me detailed meeting prep
4. Flag items mentioned in multiple places as high priority
5. I prefer 90-minute focus blocks, not 2-hour blocks
```

**Claude will customize** the plan to your specifications.

---

## Troubleshooting Prompts

### Tool Not Called

If Claude responds without calling the tool:

```
Call list-all-tasks-today first, then plan my day based on the actual data.
```

### Wrong Data Interpreted

If Claude seems confused:

```
Call list-all-tasks-today again and show me the raw JSON.
I want to verify what data you're seeing.
```

### Refresh Data

If data seems stale:

```
Call list-all-tasks-today to get fresh data, then replan my day.
```

---

## Share Your Prompts

Found an effective prompt? Share it with your team or contribute back to this documentation.

## Next Steps

1. Try the basic prompts (morning briefing, what's next)
2. Experiment with specialized queries
3. Adapt prompts to your workflow
4. Create shortcuts for your most-used prompts (see [claude-desktop-setup.md](./claude-desktop-setup.md))
