import { useState } from 'react'
import type { Task } from '../types/tasks'
import { SourceIcon, getSourceLabel } from './SourceIcon'
import { getPriorityLabel } from '../utils/priorityHelpers'
import { Chevron } from './Chevron'
import { formatDueDate, formatTime, formatDate, isToday } from '../utils/dateHelpers'
import {
  isLinearTask,
  isGmailTask,
  isGitHubTask,
  isSlackTask,
  isCalendarTask,
  isDocsActionTask,
  isMeetingNotesTask,
  type TaskSource,
  type RelatedItem,
} from '../types/tasks'
import './TaskCard.css'

const COMPLETABLE_SOURCES: TaskSource[] = ['gmail', 'slack', 'meeting-notes', 'docs']

interface TaskCardProps {
  task: Task
  onMarkComplete?: (task: Task) => void
  onViewSource?: (task: Task) => void
}

export function TaskCard({ task, onMarkComplete, onViewSource }: TaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  // Extract task-specific properties
  const getTaskTitle = (): string => {
    if (isLinearTask(task)) return task.title
    if (isGmailTask(task)) return task.subject
    if (isGitHubTask(task)) return task.title
    if (isSlackTask(task)) return task.text
    if (isCalendarTask(task)) return task.summary
    if (isDocsActionTask(task)) return task.fileTitle
    if (isMeetingNotesTask(task)) return task.actionItem
    return 'Unknown task'
  }

  const getTaskUrl = (): string | undefined => {
    if (isLinearTask(task)) return task.url
    if (isGmailTask(task)) return task.link
    if (isGitHubTask(task)) return task.url
    if (isSlackTask(task)) return task.link
    if (isCalendarTask(task)) return task.htmlLink
    if (isDocsActionTask(task)) return task.fileLink
    if (isMeetingNotesTask(task)) return task.documentLink
    return undefined
  }

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
      metadata.push(`${task.channel}`)
      metadata.push(isToday(task.timestamp) ? formatTime(task.timestamp) : formatDate(task.timestamp))
    }

    if (isCalendarTask(task)) {
      metadata.push(formatTime(task.start))
      if (task.attendees) {
        metadata.push(`${task.attendees.length} attendees`)
      }
    }

    if (isDocsActionTask(task) || isMeetingNotesTask(task)) {
      metadata.push(isToday(task.timestamp) ? formatTime(task.timestamp) : formatDate(task.timestamp))
    }

    return metadata
  }

  const title = getTaskTitle()
  const url = getTaskUrl()
  const metadata = getTaskMetadata()
  const crossRefs = 'crossReferences' in task ? task.crossReferences : undefined
  const hasCrossReferences = crossRefs && crossRefs.mentionedIn && crossRefs.mentionedIn.length > 0

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
          <h3 className="task-card__title">{title}</h3>
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
              Also mentioned in: {crossRefs!.mentionedIn!.map((source: TaskSource) => getSourceLabel(source)).join(', ')}
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
            className="task-card__action task-card__action--complete"
            onClick={() => onMarkComplete(task)}
          >
            Mark Complete
          </button>
        )}
      </div>
    </div>
  )
}
