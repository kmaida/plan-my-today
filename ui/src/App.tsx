import { useState, useEffect, useCallback } from 'react'
import { TaskGroup } from './components/TaskGroup'
import { listAllTasks, markEmailComplete, markActionComplete } from './api/client'
import type { Task } from './types/tasks'
import { isGmailTask, isSlackTask, isMeetingNotesTask, isDocsActionTask } from './types/tasks'
import { formatTime } from './utils/dateHelpers'
import './App.css'

function getTaskIdentifier(task: Task): string {
  if (isGmailTask(task)) return task.id
  if (isSlackTask(task)) return task.link || task.timestamp
  if (isMeetingNotesTask(task)) return task.documentId
  if (isDocsActionTask(task)) return task.fileLink || task.fileTitle
  return ''
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const result = await listAllTasks()
      setTasks(result.tasks)
      setFetchedAt(result.fetchedAt)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const criticalTasks = tasks.filter(t => t.priorityMetadata.category === 'critical')
  const highTasks = tasks.filter(t => t.priorityMetadata.category === 'high')
  const mediumTasks = tasks.filter(t => t.priorityMetadata.category === 'medium')
  const lowTasks = tasks.filter(t => t.priorityMetadata.category === 'low')

  const handleMarkComplete = useCallback(async (task: Task) => {
    // Optimistic: remove from state immediately
    setTasks(prev => prev.filter(t => t !== task))

    try {
      if (isGmailTask(task)) {
        await markEmailComplete(task.id)
      } else {
        // Slack, meeting-notes, docs all use mark-action-complete
        const source = task.source === 'meeting-notes' ? 'meeting-note' : task.source
        const identifier = getTaskIdentifier(task)
        await markActionComplete(source as 'meeting-note' | 'slack' | 'adhoc', identifier)
      }
    } catch {
      // Restore task on failure
      setTasks(prev => [...prev, task].sort((a, b) => b.priorityMetadata.score - a.priorityMetadata.score))
    }
  }, [])

  const snapshotLabel = fetchedAt
    ? `Snapshot from ${formatTime(fetchedAt)}`
    : 'Using sample data'

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__content">
          <div className="app-header__top">
            <h1>Your Tasks</h1>
            <button
              className="app-header__reload"
              onClick={fetchTasks}
              disabled={loading}
              title="Reload from latest snapshot"
            >
              {loading ? 'Reloading...' : 'Reload'}
            </button>
          </div>
          <p className="app-header__subtitle">
            {loading ? 'Loading...' : `${tasks.length} tasks across all sources`}
          </p>
          <p className="app-header__snapshot">
            {snapshotLabel}
            {!loading && (
              <> — ask your agent what you have to do today to capture a fresh list</>
            )}
          </p>
        </div>
      </header>

      <main className="app-main">
        <div className="app-content">
          {loading && (
            <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)', padding: 'var(--space-xl)' }}>
              Fetching tasks from all sources...
            </p>
          )}

          {error && (
            <div style={{
              padding: 'var(--space-md)',
              margin: 'var(--space-md) 0',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 'var(--radius-md)',
              color: '#991b1b',
            }}>
              <strong>Error:</strong> {error}
            </div>
          )}

          {!loading && !error && tasks.length === 0 && (
            <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)', padding: 'var(--space-xl)' }}>
              No tasks found. All clear!
            </p>
          )}

          {!loading && tasks.length > 0 && (
            <>
              {criticalTasks.length > 0 && (
                <TaskGroup
                  label="Critical"
                  count={criticalTasks.length}
                  tasks={criticalTasks}
                  defaultCollapsed={false}
                  onMarkComplete={handleMarkComplete}
                />
              )}

              {highTasks.length > 0 && (
                <TaskGroup
                  label="High"
                  count={highTasks.length}
                  tasks={highTasks}
                  defaultCollapsed={false}
                  onMarkComplete={handleMarkComplete}
                />
              )}

              {mediumTasks.length > 0 && (
                <TaskGroup
                  label="Medium"
                  count={mediumTasks.length}
                  tasks={mediumTasks}
                  defaultCollapsed={mediumTasks.length > 5}
                  onMarkComplete={handleMarkComplete}
                />
              )}

              {lowTasks.length > 0 && (
                <TaskGroup
                  label="Low"
                  count={lowTasks.length}
                  tasks={lowTasks}
                  defaultCollapsed={true}
                  onMarkComplete={handleMarkComplete}
                />
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}

export default App
