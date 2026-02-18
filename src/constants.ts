/**
 * Application-wide constants
 * Centralizes magic numbers for maintainability and documentation
 */

import { config } from "./config";

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
  EMOJI_NAME: config.slackEmojiName,
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
  /** Meeting summaries fetch limit (max Google Docs to fetch) */
  MEETINGS: 5,
  /** Max action items returned from meeting notes (applied after priority sort) */
  MEETING_NOTE_ACTIONS: 10,
} as const;

/** File paths */
export const PATHS = {
  /** Task store JSON written by list-all-tasks-today, read by UI and read-dashboard-tasks */
  TASK_STORE: "data/latest-tasks.json",
} as const;
