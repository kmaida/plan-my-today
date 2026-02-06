import { useState } from 'react'
import type { Task } from '../types/tasks'
import { TaskCard } from './TaskCard'
import { Chevron } from './Chevron'
import './TaskGroup.css'

interface TaskGroupProps {
  label: string
  count: number
  tasks: Task[]
  defaultCollapsed?: boolean
  onMarkComplete?: (task: Task) => void
  onViewSource?: (task: Task) => void
}

export function TaskGroup({
  label,
  count,
  tasks,
  defaultCollapsed = false,
  onMarkComplete,
  onViewSource,
}: TaskGroupProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)

  return (
    <div className="task-group">
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
            tasks.map((task, index) => (
              <TaskCard
                key={`${task.source}-${index}`}
                task={task}
                onMarkComplete={onMarkComplete}
                onViewSource={onViewSource}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
