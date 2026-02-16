# Agent-Based Daily Planning

Transform your plan-my-today data into actionable daily plans using LLM agents like Claude Desktop.

## Overview

The plan-my-today aggregates and enriches tasks from multiple sources (Calendar, Linear, GitHub, Gmail, Slack, Google Drive), providing rich metadata including:

- **Priority scores** (0-300 scale with categories)
- **Dependency metadata** (blocking relationships)
- **Cross-reference metadata** (mentions across sources)
- **Meeting context metadata** (related work items for events)

This documentation shows you how to use these capabilities with an LLM agent for intelligent daily planning.

## Why Agent-Based Planning?

- **Flexible**: Works for morning briefings, on-demand planning, and end-of-day reviews
- **Intelligent**: Leverages LLM reasoning with your rich metadata
- **No code changes**: Pure prompt-based approach
- **Customizable**: Adapt prompts to your planning style

## Quick Start

### Prerequisites

1. Your plan-my-today is running and configured
2. Claude Desktop (or other MCP-compatible client) is set up
3. The `list-all-tasks-today` tool is accessible

### 5-Minute Setup

1. **Verify MCP Connection**
   ```
   Ask Claude: "Do you have access to list-all-tasks-today?"
   ```

2. **Add System Prompt**
   - Copy the prompt from [system-prompt.md](./system-prompt.md)
   - Add to Claude Desktop as a custom instruction or project
   - See [claude-desktop-setup.md](./claude-desktop-setup.md) for detailed steps

3. **Test It**
   ```
   Ask Claude: "Plan my day"
   ```
   Claude will call `list-all-tasks-today` and create a personalized plan.

## Documentation

### Core Documents

- **[system-prompt.md](./system-prompt.md)** - The system prompt that instructs the agent how to analyze your data and create plans
- **[claude-desktop-setup.md](./claude-desktop-setup.md)** - Step-by-step setup guide for Claude Desktop
- **[example-prompts.md](./example-prompts.md)** - Pre-written prompts for different planning scenarios

### Reference

- **[metadata-guide.md](./metadata-guide.md)** - Detailed explanation of how to use each metadata type
- **[data-reference.md](./data-reference.md)** - Quick lookup for data structures, thresholds, and constants

## Planning Capabilities

### 1. Dependency Awareness

The agent identifies:
- Items blocking other work → prioritize to unblock downstream tasks
- Items currently blocked → explain what's waiting
- External blockers → suggest follow-ups

**Example prompt:** "What's blocking work and what would unblock tasks?"

### 2. Meeting Preparation

For each meeting, the agent surfaces:
- Related Linear issues and GitHub PRs to review
- Emails from attendees that need replies
- Pending item counts per attendee
- Meeting summary/recording links

**Example prompt:** "Prep me for my 10am meeting"

### 3. Time Blocking

The agent suggests:
- Focus blocks between meetings
- Which tasks to work on in available time
- Task grouping for efficiency

**Example prompt:** "I have 2 hours free now, what should I work on?"

### 4. Cross-Source Context

The agent groups:
- Items mentioned across email, Slack, Linear, GitHub
- Shows snippets from each source
- Uses mention count as importance signal

**Example prompt:** "What items are mentioned in multiple places?"

## Common Workflows

### Morning Briefing
```
"Plan my day"
```
Get a comprehensive plan with priorities, time blocks, meeting prep, and forgotten items.

### On-Demand Planning
```
"What should I work on next?"
```
Get focused recommendations based on current context.

### Meeting Preparation
```
"Prep me for [meeting name]"
```
See related issues, PRs, emails, and attendee context.

### Dependency Analysis
```
"What's blocking work?"
```
See blocking dependencies and unblocking opportunities.

### End-of-Day Review
```
"Review my day and plan for tomorrow"
```
Summary of completed items and priorities for tomorrow.

## How It Works

1. **You ask** the agent to help with planning
2. **Agent calls** the `list-all-tasks-today` MCP tool
3. **Tool returns** enriched JSON with all your tasks and metadata
4. **Agent analyzes** the data using the system prompt instructions:
   - Priority scores → determines order and urgency
   - Dependency metadata → identifies blockers and unblocking tasks
   - Cross-reference metadata → groups related work
   - Meeting context metadata → prepares for events
5. **Agent responds** with a personalized plan

## Example Output

```markdown
## Executive Summary
🔴 3 critical items, 5 high priority items
⚠️ 2 items blocked, PROJ-123 would unblock 3 tasks
📣 PROJ-456 mentioned 4 times across Slack and email

## Time-Blocked Schedule

**9:00-10:00 - Team Sync**
- Review: PROJ-123 (project match)
- Reply to Jane's email about Q1 planning
- Jane has 2 pending items

**10:00-12:00 - Focus Block**
1. PROJ-123 (critical, due today) - Unblocks 3 other tasks
2. PROJ-789 (high priority) - Mentioned in 2 Slack threads

**12:00-1:00 - Lunch**

**1:00-3:00 - Focus Block**
1. Review PR #456 (review requested 2 hours ago)
2. PROJ-234 (medium priority)

...
```

## Customization

### Adjust Planning Style

Modify the system prompt to match your preferences:
- Change working hours (default: 9am-5pm)
- Adjust priority thresholds
- Add domain-specific terminology
- Customize output format

### Create Shortcuts

Set up quick commands in Claude Desktop:
- "PMD" → "Plan my day"
- "WN" → "What's next?"
- "PM" → "Prep me for meetings"

## Troubleshooting

### Agent doesn't call the tool

**Issue:** Agent tries to help without calling `list-all-tasks-today`

**Fix:** Be explicit in your prompt:
```
"Call list-all-tasks-today and plan my day based on the results"
```

### Missing data sources

**Issue:** Some sources return empty arrays

**Fix:** Check `metadata.errors` in the response - likely auth issues. Use the auth dashboard at `/auth` to reconnect.

### Priority scores seem wrong

**Issue:** Items have unexpected priority scores

**Fix:** Scores are calculated based on multiple factors. See [metadata-guide.md](./metadata-guide.md) for scoring logic, or ask the agent to explain the reasoning.

### Agent is too verbose/brief

**Issue:** Output is too long or too short

**Fix:** Add guidance to your prompt:
```
"Give me a concise summary (bullet points only)"
"Give me a detailed analysis with reasoning"
```

## Advanced Usage

### Multiple Planning Strategies

Create separate Claude Desktop projects:
- "Daily Planning (Aggressive)" - Focus on high-output days
- "Daily Planning (Balanced)" - Standard planning
- "Daily Planning (Conservative)" - Realistic time estimates

Each can have a customized system prompt.

### Automated Daily Briefing

Use the MCP SDK to create a script that:
1. Calls `list-all-tasks-today`
2. Passes data to Claude API with the system prompt
3. Sends the plan via email/Slack
4. Runs daily via cron or GitHub Actions

See the [Claude API documentation](https://docs.anthropic.com/) for details.

### Team Planning

Share your system prompt with your team so everyone uses consistent planning logic. Fork and customize for different roles (engineering, design, management).

## Architecture Notes

### Why No Server Changes?

The plan-my-today is intentionally designed as a **pure data aggregation and enrichment layer**. Adding planning logic would:
- Violate separation of concerns
- Reduce flexibility (hardcoded logic vs. adaptable prompts)
- Make it harder to customize for different users
- Require more testing and maintenance

By using prompts, you get:
- Fast iteration (change prompts, not code)
- LLM reasoning (better than hardcoded rules)
- Easy customization (fork prompts for your needs)
- No deployment required (prompts live client-side)

### When to Consider Server-Side Planning

If after testing you find that prompts don't provide enough structure, consider:
- Creating a new `plan-my-day` MCP tool
- Returns structured planning recommendations
- Good for consistency across different agents
- See "Future Enhancements" in the implementation plan

## Feedback & Contributions

This is a living document. As you use agent-based planning:
- Document edge cases you encounter
- Share effective prompts with the team
- Suggest improvements to the system prompt

## Resources

- [MCP Documentation](https://modelcontextprotocol.io/)
- [Claude Desktop Setup](https://claude.ai/download)
- [plan-my-today README](../../README.md)

## License

This documentation is part of the plan-my-today project and shares the same Apache 2.0 license.
