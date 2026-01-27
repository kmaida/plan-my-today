# Changelog

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
