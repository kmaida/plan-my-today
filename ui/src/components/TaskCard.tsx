import { useState, useEffect, useRef, useMemo, useCallback, memo, type ReactNode } from 'react'
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
import '../styles/hint-tooltip.css'
import './TaskCard.css'

// Sources that support dismissal from the UI.
// Meeting-notes, docs, and slack (non-saved) use the no-auth REST endpoint (local completion store).
const DISMISSABLE_SOURCES: TaskSource[] = ['meeting-notes', 'docs', 'slack']

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
  onDismiss?: (task: Task) => void
  onViewSource?: (task: Task) => void
  isCompleting?: boolean
  hasError?: boolean
  /** When true, plays collapse-out animation then calls onExitComplete */
  isExiting?: boolean
  /** Called after the exit animation finishes so the parent can remove the card from state */
  onExitComplete?: () => void
  /** When true, plays expand-in animation on mount (used after undo restore) */
  isRestoring?: boolean
}

/** Fallback timeout if transitionend doesn't fire (e.g. prefers-reduced-motion) */
const EXIT_ANIMATION_TIMEOUT = 300

export const TaskCard = memo(function TaskCard({ task, onDismiss, onViewSource, isCompleting, hasError, isExiting, onExitComplete, isRestoring }: TaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [animatingIn, setAnimatingIn] = useState(!!isRestoring)

  // Restore enter animation: mount with animatingIn=true, then flip on next frame
  // so the CSS transition from 0fr → 1fr fires.
  useEffect(() => {
    if (!isRestoring) return
    // Force the browser to paint the collapsed state first
    requestAnimationFrame(() => {
      setAnimatingIn(false)
    })
  }, [isRestoring])

  // Exit animation: listen for transitionend to signal removal.
  // Falls back to a timeout in case the transition doesn't fire
  // (e.g. prefers-reduced-motion disables transitions, or element is detached).
  useEffect(() => {
    if (!isExiting) return
    const el = wrapperRef.current
    if (!el) { onExitComplete?.(); return }
    let didComplete = false
    const complete = () => {
      if (didComplete) return
      didComplete = true
      onExitComplete?.()
    }
    const handleEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'grid-template-rows') complete()
    }
    el.addEventListener('transitionend', handleEnd)
    const fallback = setTimeout(complete, EXIT_ANIMATION_TIMEOUT)
    return () => {
      el.removeEventListener('transitionend', handleEnd)
      clearTimeout(fallback)
    }
  }, [isExiting, onExitComplete])

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
      if (task.documentTitle) {
        // Granola names docs like "Meeting Title - 2026-02-12T15:00:00-05:00";
        // strip the trailing ISO timestamp since the doc title is the useful context.
        const cleanTitle = task.documentTitle.replace(/\s*-\s*\d{4}-\d{2}-\d{2}T\S+$/, '')
        items.push(cleanTitle || task.documentTitle)
      }
      // Only show date for non-today meetings; today's meetings don't need a bare time
      // since the document title already identifies the meeting.
      if (!isToday(task.timestamp)) {
        items.push(formatDate(task.timestamp))
      }
    }

    return items
  }, [task])

  const crossRefs = task.crossReferences
  const otherSources = useMemo(
    () => crossRefs?.mentionedIn?.filter((s: TaskSource) => s !== task.source) ?? [],
    [crossRefs?.mentionedIn, task.source],
  )
  const hasCrossReferences = otherSources.length > 0 || (crossRefs?.relatedItems && crossRefs.relatedItems.length > 0)
  const labelSources = useMemo(() => {
    const sources = new Set(otherSources.map(getSourceLabel))
    crossRefs?.relatedItems?.forEach((item: RelatedItem) => {
      sources.add(getSourceLabel(item.source))
    })
    return Array.from(sources)
  }, [otherSources, crossRefs?.relatedItems])

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
  const handleDismiss = useCallback(() => { if (onDismiss) onDismiss(task) }, [onDismiss, task])

  const cardClassName = [
    'task-card',
    isExpanded && 'task-card--expanded',
  ].filter(Boolean).join(' ')

  const wrapperClassName = [
    'task-card-wrapper',
    isExiting && 'task-card-wrapper--exiting',
    animatingIn && 'task-card-wrapper--entering',
  ].filter(Boolean).join(' ')

  return (
    <div className={wrapperClassName} ref={wrapperRef}>
      <div className="task-card-wrapper__inner">
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
                  Referenced in:{labelSources.length > 0 ? ` ${labelSources.join(', ')}` : ''}
                </span>
              </div>

              <div className={`task-card__collapse${isExpanded ? ' task-card__collapse--open' : ''}`}>
                <div className="task-card__collapse-inner">
                  {crossRefs?.relatedItems && crossRefs.relatedItems.length > 0 && (
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
                              <span className="task-card__related-snippet">{item.snippet}</span>
                            )
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
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
            {onDismiss && DISMISSABLE_SOURCES.includes(task.source)
              && !(isSlackTask(task) && task.type === 'saved') && (
              <>
                <button
                  className={`task-card__action task-card__action--dismiss${hasError ? ' task-card__action--error' : ''}`}
                  onClick={handleDismiss}
                  disabled={isCompleting}
                >
                  {isCompleting ? 'Dismissing...' : hasError ? 'Failed — Retry' : 'Dismiss'}
                </button>
                {isDocsActionTask(task) && task.docsType === 'unresolved-comment' && (
                  <span className="hint-tooltip">
                    <svg className="hint-tooltip__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                      <text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="11" fontWeight="600">!</text>
                    </svg>
                    <span className="hint-tooltip__tooltip">Resolve comments in Google Docs — they'll disappear from the dashboard automatically.</span>
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
