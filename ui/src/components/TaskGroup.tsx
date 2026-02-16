import { useState, useMemo, useEffect, memo } from 'react'
import type { Task } from '../types/tasks'
import { TaskCard } from './TaskCard'
import { Chevron } from './Chevron'
import './TaskGroup.css'

const INITIAL_VISIBLE = 5
const LOAD_MORE_INCREMENT = 10

interface TaskGroupProps {
  label: string
  count: number
  tasks: Task[]
  defaultCollapsed?: boolean
  onDismiss?: (task: Task) => void
  onViewSource?: (task: Task) => void
  dismissingTaskIds?: Set<string>
  dismissError?: string | null
  exitingTaskIds?: Set<string>
  restoredTaskId?: string | null
  onExitComplete?: (taskId: string) => void
  /** One-shot signal: when true, expands this group (user can still re-collapse). */
  forceExpanded?: boolean
}

export const TaskGroup = memo(function TaskGroup({
  label,
  count,
  tasks,
  defaultCollapsed = false,
  onDismiss,
  onViewSource,
  dismissingTaskIds,
  dismissError,
  exitingTaskIds,
  restoredTaskId,
  onExitComplete,
  forceExpanded,
}: TaskGroupProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE)

  useEffect(() => {
    if (forceExpanded) setIsCollapsed(false)
  }, [forceExpanded])

  const visibleTasks = useMemo(() => tasks.slice(0, visibleCount), [tasks, visibleCount])
  const remaining = tasks.length - visibleCount

  const groupSlug = useMemo(
    () => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    [label],
  )

  return (
    <div className="task-group" data-group={groupSlug}>
      <button
        className="task-group__header"
        onClick={() => setIsCollapsed(!isCollapsed)}
        aria-expanded={!isCollapsed}
      >
        <h2 className="task-group__title">
          {label} <span className="task-group__count">({count})</span>
        </h2>
        <Chevron direction={isCollapsed ? 'right' : 'down'} size={14} className="task-group__toggle" />
      </button>

      <div className={`task-group__collapse ${isCollapsed ? '' : 'task-group__collapse--open'}`}>
        <div className="task-group__content">
          {tasks.length === 0 ? (
            <p className="task-group__empty">No tasks in this group</p>
          ) : (
            <>
              {visibleTasks.map((task, index) => (
                <TaskCard
                  key={task.taskId || `${task.source}-${index}`}
                  task={task}
                  onDismiss={onDismiss}
                  onViewSource={onViewSource}
                  isCompleting={dismissingTaskIds?.has(task.taskId) ?? false}
                  hasError={dismissError === task.taskId}
                  isExiting={exitingTaskIds?.has(task.taskId) ?? false}
                  onExitComplete={exitingTaskIds?.has(task.taskId) ? () => onExitComplete?.(task.taskId) : undefined}
                  isRestoring={restoredTaskId === task.taskId}
                />
              ))}
              {remaining > 0 && (
                <button
                  className="task-group__show-more"
                  onClick={() => setVisibleCount(prev => prev + LOAD_MORE_INCREMENT)}
                >
                  Show more ({remaining} remaining)
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
})
