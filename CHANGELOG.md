# Changelog

## [Unreleased] — A2A delegation to ROIbot (May 2026)

### BREAKING CHANGES

- **Replaced ROIbot MCP-proxy with A2A task delegation.** The old approach connected
  Todaygent to ROIbot's MCP server as a client, exposing every ROIbot tool name to
  Todaygent's LLM. The new approach uses the A2A protocol to send a free-form task
  description to ROIbot's `/api/agent` endpoint; ROIbot's own agent picks tools
  internally and returns a coherent answer. Todaygent's LLM never sees ROIbot's
  tool names.
- `ROIBOT_MCP_ENDPOINT` env var renamed to `ROIBOT_AGENT_ENDPOINT`. Set it to
  ROIbot's `/api/agent` URL (e.g. `https://event-roi.fly.dev/api/agent`).
- The two old delegation tools (`list-roibot-tools`, `delegate-to-roibot`) have
  been removed. Replacements: `delegate-task-to-roibot` (LLM-facing) and
  `resume-roibot-task` (internal — invoked by the chat UI after user approval,
  never by the LLM directly).

### Added

- **`@a2a-js/sdk@^0.3.13`** — A2A protocol client for delegated agent calls.
- **UI-enforced HITL approval card.** When ROIbot returns `input-required` for a
  Tier-1 destructive action, Todaygent's chat UI pauses the agentic loop and
  renders an `ApprovalCard` inline. The user clicks Approve/Deny per pending
  tool call; submitting calls `resume-roibot-task` and the LLM resumes with the
  synthetic tool result. The LLM physically cannot self-approve because it
  never sees the pending state.
- New files:
  - `src/services/roibot-a2a-client.ts` — `startTask` / `resumeTask` via A2A SDK.
  - `src/tools/delegate-task-to-roibot.ts` — the two delegation tools.
  - `ui/src/components/Chat/ApprovalCard.{tsx,css}` — per-tool approval UI.

### Changed

- `ui/src/chat/types.ts` — added `PendingApprovalMeta`, `ApprovalDecisions`,
  `PendingToolCall`; `ChatMessage` gained an optional `pendingApproval` field.
- `ui/src/chat/useChat.ts` — detects `_meta.pendingApproval` on tool results,
  awaits user click via promise, calls resume tool, feeds synthetic result to
  the LLM. The LLM never sees the pending state.
- `ui/src/chat/system-prompt.ts` — describes the new tool plus the rule
  "never call `resume-roibot-task` yourself."

## [0.2.3](https://github.com/kmaida/plan-my-today/compare/v0.2.1...v0.2.3) (2026-02-20)

## [0.2.0] - 2026-01-27

### BREAKING CHANGES
- **Removed `list-today-todos` tool** - Deprecated in favor of agent-based planning with `list-all-tasks-today`
  - Old tool: Pre-formatted markdown with built-in timeline and insights
  - New approach: Raw JSON with priority metadata for LLM agent consumption
  - Agents create personalized plans adapted to user context

### Migration Guide
- Replace `list-today-todos` calls with agent workflows using `list-all-tasks-today`
- See [TESTING_LIST_ALL_TASKS.md](./TESTING_LIST_ALL_TASKS.md) for detailed guidance
- Priority metadata (score, category, signals, reasons) enables intelligent planning

### Removed
- Tool registration for `list-today-todos`
- Implementation files: `index.ts`, `insights.ts`, `timeline.ts` (~1700 lines)

### Preserved
- All shared utilities: calendar, linear, email, docs, github, slack
- Priority calculation functions for `list-all-tasks-today`
- Type definitions

### Documentation
- Added migration notice to README
- Expanded TESTING_LIST_ALL_TASKS.md with comparison and examples
- Updated all user-facing messages
