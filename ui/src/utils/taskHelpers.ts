// Task helpers - search text extraction, timestamp extraction, and filtering

import type { Task, FilterState, TaskSource } from '../types/tasks'
import {
  isLinearTask, isGmailTask, isGitHubTask,
  isSlackTask, isCalendarTask, isDocsActionTask, isMeetingNotesTask,
} from '../types/tasks'
import { isToday, isThisWeek } from './dateHelpers'

/**
 * Extract searchable text from any task type.
 * Includes title plus secondary fields (from, repo, channel, etc.)
 */
export function getTaskSearchText(task: Task): string {
  const parts: string[] = []
  if (isLinearTask(task)) {
    parts.push(task.title, task.identifier, task.project || '', task.state || '')
  } else if (isGmailTask(task)) {
    parts.push(task.subject, task.from)
  } else if (isGitHubTask(task)) {
    parts.push(task.title, task.repo, `#${task.number}`)
  } else if (isSlackTask(task)) {
    parts.push(task.text, task.channel, task.user)
  } else if (isCalendarTask(task)) {
    parts.push(task.summary, task.location || '')
  } else if (isDocsActionTask(task)) {
    parts.push(task.fileTitle, task.actionType)
  } else if (isMeetingNotesTask(task)) {
    parts.push(task.actionItem, task.assignee || '')
  }
  return parts.join(' ').toLowerCase()
}

/**
 * Get the relevant timestamp for a task (used for time filtering and timeline grouping).
 * Returns ISO string or null if no date is available.
 */
export function getTaskTimestamp(task: Task): string | null {
  if (isCalendarTask(task)) return task.start
  if (isLinearTask(task)) return task.dueDate || null
  if (isGmailTask(task)) return task.timestamp
  if (isSlackTask(task)) return task.timestamp
  if (isDocsActionTask(task)) return task.timestamp
  if (isMeetingNotesTask(task)) return task.timestamp
  // GitHub tasks don't carry a meaningful due date
  return null
}

/**
 * Get the task title for display purposes.
 * Shared helper to avoid duplicating the switch-on-type logic.
 */
export function getTaskTitle(task: Task): string {
  if (isLinearTask(task)) return task.title
  if (isGmailTask(task)) return task.subject
  if (isGitHubTask(task)) return task.title
  if (isSlackTask(task)) return task.text
  if (isCalendarTask(task)) return task.summary
  if (isDocsActionTask(task)) return task.fileTitle
  if (isMeetingNotesTask(task)) return task.actionItem
  return 'Unknown task'
}

/**
 * Normalize a task's source for filtering purposes.
 * Collapses 'github-issue' into 'github' so filter chips work intuitively.
 */
export function normalizeSource(source: TaskSource): TaskSource {
  return source === 'github-issue' ? 'github' : source
}

/**
 * Apply the full FilterState to a list of tasks.
 * Empty sources/priorities arrays = show all (inclusive default).
 */
export function applyFilters(tasks: Task[], filters: FilterState): Task[] {
  return tasks.filter(task => {
    // Search filter
    if (filters.search) {
      const query = filters.search.toLowerCase()
      if (!getTaskSearchText(task).includes(query)) return false
    }

    // Source filter (empty = all sources shown)
    if (filters.sources.length > 0) {
      if (!filters.sources.includes(normalizeSource(task.source))) return false
    }

    // Priority filter (empty = all priorities shown)
    if (filters.priorities.length > 0) {
      if (!filters.priorities.includes(task.priorityMetadata.category)) return false
    }

    // Time filter
    if (filters.timeFilter !== 'all') {
      const ts = getTaskTimestamp(task)
      switch (filters.timeFilter) {
        case 'today':
          if (!ts || !isToday(ts)) return false
          break
        case 'week':
          if (!ts || !isThisWeek(ts)) return false
          break
        case 'later':
          if (!ts || isToday(ts) || isThisWeek(ts)) return false
          break
        case 'no-due':
          if (ts) return false
          break
        case 'overdue': {
          if (!ts) return false
          if (new Date(ts).getTime() >= Date.now()) return false
          break
        }
      }
    }

    return true
  })
}
