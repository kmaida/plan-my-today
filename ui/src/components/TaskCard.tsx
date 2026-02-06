import { useState, type ReactNode } from 'react'
import type { Task, TaskSource, RelatedItem } from '../types/tasks'
import {
  isLinearTask, isGmailTask, isGitHubTask, isSlackTask,
  isCalendarTask, isDocsActionTask, isMeetingNotesTask,
} from '../types/tasks'
import { getTaskTitle, getTaskUrl } from '../utils/taskHelpers'
import { getPriorityLabel } from '../utils/priorityHelpers'
import { formatDueDate, formatTime, formatDate, isToday } from '../utils/dateHelpers'
import { SourceIcon, getSourceLabel } from './SourceIcon'
import { Chevron } from './Chevron'
import './TaskCard.css'

// Sources that support mark-complete from the UI (no OAuth required).
// Gmail is excluded because it needs a Gmail API token we can't provide from the UI.
const COMPLETABLE_SOURCES: TaskSource[] = ['slack', 'meeting-notes', 'docs']

/** Parse Slack link markup (<url|label> or <url>) into React nodes with clickable links */
function parseSlackLinks(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const linkPattern = /<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = linkPattern.exec(text)) !== null) {
    // Text before the link
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index))
    }
    const url = match[1]
    const label = match[2] || new URL(url).hostname
    parts.push(
      <a key={match.index} href={url} target="_blank" rel="noopener noreferrer" className="task-card__inline-link">
        {label}
      </a>
    )
    lastIndex = match.index + match[0].length
  }

  // Remaining text after last link
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

interface TaskCardProps {
  task: Task
  onMarkComplete?: (task: Task) => void
  onViewSource?: (task: Task) => void
  isCompleting?: boolean
  hasError?: boolean
}

export function TaskCard({ task, onMarkComplete, onViewSource, isCompleting, hasError }: TaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const getTaskMetadata = (): string[] => {
    const metadata: string[] = []

    if (isLinearTask(task) && task.dueDate) {
      const due = formatDueDate(task.dueDate)
      metadata.push(due.text)
    }

    if (isGmailTask(task)) {
      metadata.push(`From: ${task.from}`)
      metadata.push(isToday(task.timestamp) ? formatTime(task.timestamp) : formatDate(task.timestamp))
    }

    if (isGitHubTask(task)) {
      metadata.push(`${task.repo}`)
      metadata.push(`#${task.number}`)
    }

    if (isSlackTask(task)) {
      const channel = task.channel
      // Skip raw channel IDs (all-caps alphanumeric like C08JF82CB1N)
      const isRawId = channel && /^[A-Z0-9]+$/.test(channel)
      if (channel && channel.startsWith('DM:')) {
        metadata.push(channel)
      } else if (channel && channel === 'DM') {
        metadata.push(channel)
      } else if (channel && !isRawId) {
        metadata.push(`#${channel}`)
      }
      metadata.push(isToday(task.timestamp) ? formatTime(task.timestamp) : formatDate(task.timestamp))
    }

    if (isCalendarTask(task)) {
      const calendarDate = isToday(task.start) ? formatTime(task.start) : `${formatDate(task.start)} ${formatTime(task.start)}`
      metadata.push(calendarDate)
      if (task.attendees) {
        metadata.push(`${task.attendees.length} attendees`)
      }
    }

    if (isDocsActionTask(task) || isMeetingNotesTask(task)) {
      metadata.push(isToday(task.timestamp) ? formatTime(task.timestamp) : formatDate(task.timestamp))
    }

    return metadata
  }

  const title = getTaskTitle(task)
  const url = getTaskUrl(task)
  const metadata = getTaskMetadata()
  const crossRefs = task.crossReferences
  // Only show the expand section when the item is mentioned in OTHER sources
  // (not just its own source) or has actual related items
  const otherSources = crossRefs?.mentionedIn?.filter((s: TaskSource) => s !== task.source) ?? []
  const hasCrossReferences = otherSources.length > 0 || (crossRefs?.relatedItems && crossRefs.relatedItems.length > 0)

  const priorityLabel = getPriorityLabel(task.priorityMetadata.category)

  // Format reasons as a sentence-case string
  const reasons = task.priorityMetadata.reasons
  const formattedReasons = reasons
    ? reasons.charAt(0).toUpperCase() + reasons.slice(1).toLowerCase()
    : ''

  return (
    <div className={`task-card${isExpanded ? ' task-card--expanded' : ''}`}>
      <div className="task-card__header">
        <span className={`task-card__priority-tag task-card__priority-tag--${task.priorityMetadata.category}`}>{priorityLabel}</span>
        <div className="task-card__title-row">
          <h3 className="task-card__title">
            {isSlackTask(task) && title.includes('<http') ? parseSlackLinks(title) : title}
          </h3>
        </div>

        <div className="task-card__meta">
          <span className={`task-card__source${metadata.length > 0 ? ' task-card__source--with-divider' : ''}`}><SourceIcon source={task.source} showLabel /></span>
          {metadata.map((meta, i) => (
            <span key={i} className="task-card__meta-item">
              {i > 0 && ' · '}
              {meta}
            </span>
          ))}
        </div>

        {formattedReasons && (
          <p className="task-card__reasons">{formattedReasons}</p>
        )}
      </div>

      {isLinearTask(task) && task.dependencies && (() => {
        const linearBase = task.url?.replace(/\/[^/]+$/, '/')
        const renderIssueLinks = (ids: string[]) =>
          ids.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              {linearBase ? (
                <a href={`${linearBase}${id}`} target="_blank" rel="noopener noreferrer" className="task-card__issue-link">{id}</a>
              ) : id}
            </span>
          ))
        const hasDeps = (task.dependencies.blockedBy && task.dependencies.blockedBy.length > 0)
          || (task.dependencies.blocks && task.dependencies.blocks.length > 0)
          || (task.dependencies.waitingOn && task.dependencies.waitingOn.length > 0)
        if (!hasDeps) return null
        return (
          <div className="task-card__dependencies">
            {task.dependencies.blockedBy && task.dependencies.blockedBy.length > 0 && (
              <p><span className="task-card__dep-label">Blocked by:</span> {renderIssueLinks(task.dependencies.blockedBy)}</p>
            )}
            {task.dependencies.blocks && task.dependencies.blocks.length > 0 && (
              <p><span className="task-card__dep-label">Blocks:</span> {renderIssueLinks(task.dependencies.blocks)}</p>
            )}
            {task.dependencies.waitingOn && task.dependencies.waitingOn.length > 0 && (
              <p><span className="task-card__dep-label">Waiting on:</span> {renderIssueLinks(task.dependencies.waitingOn)}</p>
            )}
          </div>
        )
      })()}

      {hasCrossReferences && (
        <>
          <div
            className="task-card__cross-refs"
            onClick={() => setIsExpanded(!isExpanded)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsExpanded(!isExpanded) }}
          >
            <Chevron direction={isExpanded ? 'down' : 'right'} size={12} className="task-card__expand-icon" />
            <span className="task-card__cross-refs-label">
              Also mentioned in: {otherSources.map((source: TaskSource) => getSourceLabel(source)).join(', ')}
            </span>
          </div>

          {isExpanded && crossRefs?.relatedItems && crossRefs.relatedItems.length > 0 && (
            <ul className="task-card__related-list">
              {crossRefs.relatedItems.map((item: RelatedItem, i: number) => (
                <li key={i}>
                  <SourceIcon source={item.source} showLabel />
                  {item.snippet && <span className="task-card__related-sep">&middot;</span>}
                  {item.snippet && (
                    item.url ? (
                      <a href={item.url} target="_blank" rel="noopener noreferrer" className="task-card__related-link">
                        {item.snippet}
                      </a>
                    ) : (
                      <span>{item.snippet}</span>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="task-card__actions">
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="task-card__action task-card__action--view"
            onClick={() => {
              if (onViewSource) {
                onViewSource(task)
              }
            }}
          >
            View in {getSourceLabel(task.source)} →
          </a>
        )}
        {onMarkComplete && COMPLETABLE_SOURCES.includes(task.source) && (
          <button
            className={`task-card__action task-card__action--complete${hasError ? ' task-card__action--error' : ''}`}
            onClick={() => onMarkComplete(task)}
            disabled={isCompleting}
          >
            {isCompleting ? 'Completing...' : hasError ? 'Failed — Retry' : 'Mark Complete'}
          </button>
        )}
      </div>
    </div>
  )
}
