import { useState, useMemo, useCallback, memo, type ReactNode } from 'react'
import type { Task, TaskSource, RelatedItem } from '../types/tasks'
import {
  isLinearTask, isGmailTask, isGitHubTask, isSlackTask,
  isCalendarTask, isDocsActionTask, isMeetingNotesTask,
} from '../types/tasks'
import { getTaskTitle, getTaskUrl } from '../utils/taskHelpers'
import { getPriorityLabel } from '../utils/priorityHelpers'
import { formatDueDate, formatTime, formatDate, isToday, formatSmartDate } from '../utils/dateHelpers'
import { SourceIcon, getSourceLabel } from './SourceIcon'
import { Chevron } from './Chevron'
import './TaskCard.css'

// Sources that support mark-complete from the UI.
// Meeting-notes, docs, and slack (non-saved) use the no-auth REST endpoint (local completion store).
const COMPLETABLE_SOURCES: TaskSource[] = ['meeting-notes', 'docs', 'slack']

/** Labels for non-default Google Calendar event types shown in card metadata */
const CALENDAR_EVENT_TYPE_LABELS: Record<string, string> = {
  focusTime: 'Focus Time',
  outOfOffice: 'Out of Office',
  workingLocation: 'Location',
  birthday: 'Birthday',
}

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

export const TaskCard = memo(function TaskCard({ task, onMarkComplete, onViewSource, isCompleting, hasError }: TaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const title = getTaskTitle(task)
  const url = getTaskUrl(task)

  const metadata = useMemo(() => {
    const items: string[] = []

    if (isLinearTask(task) && task.dueDate) {
      const due = formatDueDate(task.dueDate)
      items.push(due.text)
    }

    if (isGmailTask(task)) {
      // Thread summary: "From: Alice +2 others" when multiple messages collapsed
      if (task.threadParticipants && task.threadParticipants.length > 1) {
        const othersCount = task.threadParticipants.length - 1
        items.push(`From: ${task.threadParticipants[0]} +${othersCount} other${othersCount > 1 ? 's' : ''}`)
      } else {
        items.push(`From: ${task.from}`)
      }
      if (task.threadMessageCount && task.threadMessageCount > 1) {
        items.push(`${task.threadMessageCount} messages`)
      }
      items.push(formatSmartDate(task.timestamp))
    }

    if (isGitHubTask(task)) {
      items.push(`${task.repo}`)
      items.push(`#${task.number}`)
    }

    if (isSlackTask(task)) {
      const channel = task.channel
      const isRawId = channel && /^[A-Z0-9]+$/.test(channel)
      if (channel && channel.startsWith('DM:')) {
        items.push(channel)
      } else if (channel && channel === 'DM') {
        items.push(channel)
      } else if (channel && !isRawId) {
        items.push(`#${channel}`)
      }
      items.push(formatSmartDate(task.timestamp))
    }

    if (isCalendarTask(task)) {
      if (task.eventType && CALENDAR_EVENT_TYPE_LABELS[task.eventType]) {
        items.push(CALENDAR_EVENT_TYPE_LABELS[task.eventType])
      }
      const calendarDate = isToday(task.start) ? formatTime(task.start) : `${formatDate(task.start)} ${formatTime(task.start)}`
      items.push(calendarDate)
      if (task.attendees && task.eventType !== 'focusTime' && task.eventType !== 'outOfOffice') {
        items.push(`${task.attendees.length} attendees`)
      }
    }

    if (isDocsActionTask(task)) {
      items.push(formatSmartDate(task.timestamp))
    }

    if (isMeetingNotesTask(task)) {
      if (task.documentTitle) items.push(task.documentTitle)
      items.push(formatSmartDate(task.timestamp))
    }

    return items
  }, [task])

  const crossRefs = task.crossReferences
  const otherSources = useMemo(
    () => crossRefs?.mentionedIn?.filter((s: TaskSource) => s !== task.source) ?? [],
    [crossRefs?.mentionedIn, task.source],
  )
  const hasCrossReferences = otherSources.length > 0 || (crossRefs?.relatedItems && crossRefs.relatedItems.length > 0)

  const priorityLabel = getPriorityLabel(task.priorityMetadata.category)

  const formattedReasons = useMemo(() => {
    const reasons = task.priorityMetadata.reasons
    return reasons ? reasons.charAt(0).toUpperCase() + reasons.slice(1).toLowerCase() : ''
  }, [task.priorityMetadata.reasons])

  const parsedTitle = useMemo(
    () => isSlackTask(task) && title.includes('<http') ? parseSlackLinks(title) : title,
    [task, title],
  )

  const toggleExpanded = useCallback(() => setIsExpanded(prev => !prev), [])
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') setIsExpanded(prev => !prev)
  }, [])
  const handleViewSource = useCallback(() => { if (onViewSource) onViewSource(task) }, [onViewSource, task])
  const handleMarkComplete = useCallback(() => { if (onMarkComplete) onMarkComplete(task) }, [onMarkComplete, task])

  const cardClassName = [
    'task-card',
    isExpanded && 'task-card--expanded',
    isCalendarTask(task) && task.eventType === 'focusTime' && 'task-card--focus-time',
    isCalendarTask(task) && task.eventType === 'outOfOffice' && 'task-card--out-of-office',
  ].filter(Boolean).join(' ')

  return (
    <div className={cardClassName}>
      <div className="task-card__header">
        <span className={`task-card__priority-tag task-card__priority-tag--${task.priorityMetadata.category}`}>{priorityLabel}</span>
        <div className="task-card__title-row">
          <h3 className="task-card__title">
            {parsedTitle}
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
            onClick={toggleExpanded}
            role="button"
            tabIndex={0}
            onKeyDown={handleKeyDown}
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
            onClick={handleViewSource}
          >
            View in {getSourceLabel(task.source)} →
          </a>
        )}
        {onMarkComplete && COMPLETABLE_SOURCES.includes(task.source)
          && !(isSlackTask(task) && task.type === 'saved') && (
          <button
            className={`task-card__action task-card__action--complete${hasError ? ' task-card__action--error' : ''}`}
            onClick={handleMarkComplete}
            disabled={isCompleting}
          >
            {isCompleting ? 'Dismissing...' : hasError ? 'Failed — Retry' : isSlackTask(task) ? 'Dismiss' : 'Mark Complete'}
          </button>
        )}
      </div>
    </div>
  )
})
