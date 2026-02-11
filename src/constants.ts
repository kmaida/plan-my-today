/**
 * Application-wide constants
 * Centralizes magic numbers for maintainability and documentation
 */

/** Calendar and scheduling defaults */
export const CALENDAR = {
  /** Default work day start hour (24-hour format) */
  WORK_START_HOUR: 9,
  /** Default work day end hour (24-hour format) */
  WORK_END_HOUR: 17,
  /** Minimum time block duration in minutes to suggest */
  MIN_TIME_BLOCK_MINUTES: 15,
  /** Maximum number of calendar results to fetch */
  MAX_RESULTS: 10,
} as const;

/** Priority score thresholds (0-300 scale) */
export const PRIORITY_THRESHOLDS = {
  /** Critical priority threshold - immediate action needed */
  CRITICAL: 180,
  /** High priority threshold - important but not urgent */
  HIGH: 130,
  /** Medium priority threshold - normal priority */
  MEDIUM: 80,
} as const;

/** Time windows for data fetching (in days) */
export const TIME_WINDOWS = {
  /** GitHub PRs and issues lookback window */
  GITHUB_DAYS: 30,
  /** Default days back for Gmail and Docs */
  DEFAULT_DAYS_BACK: 14,
  /** Slack messages lookback window */
  SLACK_DAYS_BACK: 2,
} as const;

/** Slack saved messages configuration */
export const SLACK_SAVED_MESSAGES = {
  /** Emoji name to track as "saved" (without colons, e.g., "mcp-todo-reminder") */
  EMOJI_NAME: process.env.SLACK_EMOJI_NAME || "mcp-todo-reminder",
  /** Lookback window for saved messages (in days) */
  DAYS_BACK: 14,
  /** Maximum saved messages to fetch */
  MAX_RESULTS: 15,
} as const;

/** API fetch limits (how many items to pull from each source API) */
export const FETCH_LIMITS = {
  /** Default fetch limit for most APIs */
  DEFAULT: 10,
  /** Linear issues fetch limit */
  LINEAR: 20,
  /** Gmail messages fetch limit */
  GMAIL: 15,
  /** Slack messages fetch limit */
  SLACK: 10,
  /** Meeting summaries fetch limit */
  MEETINGS: 5,
} as const;

/**
 * Display limits — max items per source returned in the tool response.
 * Applied after priority scoring: items are sorted by score (highest first)
 * and only the top N are kept. Calendar is uncapped (you need all your meetings).
 */
export const DISPLAY_LIMITS = {
  LINEAR: 10,
  GMAIL: 8,
  SLACK: 8,
  GITHUB_PRS: 5,
  GITHUB_ISSUES: 5,
  DOCS: 5,
  MEETING_SUMMARIES: 3,
  MEETING_NOTES: 5,
} as const;

/** OAuth state management */
export const OAUTH = {
  /** OAuth state expiry time in milliseconds (10 minutes) */
  STATE_EXPIRY_MS: 10 * 60 * 1000,
} as const;

/** File paths */
export const PATHS = {
  /** Cached tasks JSON written by list-all-tasks-today, read by UI and read-dashboard-tasks */
  TASKS_CACHE: "data/latest-tasks.json",
} as const;
