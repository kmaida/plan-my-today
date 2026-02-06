import { useState } from 'react'
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
  onMarkComplete?: (task: Task) => void
  onViewSource?: (task: Task) => void
  completingTaskId?: string | null
  completeError?: string | null
}

export function TaskGroup({
  label,
  count,
  tasks,
  defaultCollapsed = false,
  onMarkComplete,
  onViewSource,
  completingTaskId,
  completeError,
}: TaskGroupProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE)

  const visibleTasks = tasks.slice(0, visibleCount)
  const remaining = tasks.length - visibleCount

  const groupSlug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

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

      {!isCollapsed && (
        <div className="task-group__content">
          {tasks.length === 0 ? (
            <p className="task-group__empty">No tasks in this group</p>
          ) : (
            <>
              {visibleTasks.map((task, index) => (
                <TaskCard
                  key={task.taskId || `${task.source}-${index}`}
                  task={task}
                  onMarkComplete={onMarkComplete}
                  onViewSource={onViewSource}
                  isCompleting={completingTaskId === task.taskId}
                  hasError={completeError === task.taskId}
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
      )}
    </div>
  )
}
