import { useState, useEffect, useCallback } from 'react'
import { AuthGate, useAuth } from './auth'
import { TaskGroup } from './components/TaskGroup'
import { ViewSwitcher } from './components/ViewSwitcher'
import { FilterBar } from './components/FilterBar'
import { listAllTasks, markActionComplete } from './api/client'
import type { Task, ViewMode, FilterState } from './types/tasks'
import { applyFilters, getTaskIdentifier } from './utils/taskHelpers'
import { groupTasks } from './utils/taskGrouping'
import { formatTime, formatDate, isToday } from './utils/dateHelpers'
import './App.css'

const DEFAULT_FILTERS: FilterState = {
  search: '',
  sources: [],
  priorities: [],
  timeFilter: 'all',
  showCompleted: false,
}

function getDefaultCollapsed(viewMode: ViewMode, groupLabel: string, groupCount: number, groupIndex: number): boolean {
  if (viewMode === 'priority') {
    if (groupLabel === 'Low') return true
    if (groupLabel === 'Medium' && groupCount > 5) return true
    return false
  }
  // Other views: collapse groups past index 2
  return groupIndex > 2
}

function App() {
  const { logout } = useAuth()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('priority')
  const [filterState, setFilterState] = useState<FilterState>(DEFAULT_FILTERS)
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null)
  const [completeError, setCompleteError] = useState<string | null>(null)

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

  const filteredTasks = applyFilters(tasks, filterState)
  const taskGroups = groupTasks(filteredTasks, viewMode)

  const handleMarkComplete = useCallback(async (task: Task) => {
    setCompletingTaskId(task.taskId)
    setCompleteError(null)
    try {
      const source = task.source === 'meeting-notes' ? 'meeting-note' : task.source
      const identifier = getTaskIdentifier(task)
      await markActionComplete(source, identifier, task.taskId)
      setTasks(prev => prev.filter(t => t !== task))
    } catch (err) {
      console.error('Failed to mark complete:', err)
      setCompleteError(task.taskId)
    } finally {
      setCompletingTaskId(null)
    }
  }, [])

  const snapshotLabel = fetchedAt
    ? `Snapshot from ${isToday(fetchedAt) ? `today ${formatTime(fetchedAt)}` : `${formatDate(fetchedAt)} ${formatTime(fetchedAt)}`}`
    : 'Using sample data'

  return (
    <AuthGate>
    <div className="app">
      <header className="app-header">
        <div className="app-header__content">
          <div className="app-header__top">
            <h1>Your Tasks</h1>
            <div className="app-header__actions">
              <button
                className="app-header__reload"
                onClick={fetchTasks}
                disabled={loading}
                title="Reload from latest snapshot"
              >
                {loading ? 'Reloading...' : 'Reload'}
              </button>
              <button
                className="app-header__logout"
                onClick={logout}
                title="Sign out"
              >
                Sign out
              </button>
            </div>
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
          {!loading && tasks.length > 0 && (
            <FilterBar
              filters={filterState}
              onFiltersChange={setFilterState}
              totalCount={tasks.length}
              filteredCount={filteredTasks.length}
              viewSwitcher={<ViewSwitcher activeView={viewMode} onViewChange={setViewMode} />}
            />
          )}
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
              {filteredTasks.length === 0 ? (
                <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)', padding: 'var(--space-xl)' }}>
                  No tasks match your filters.
                </p>
              ) : (
                taskGroups.map((group, index) => (
                  <TaskGroup
                    key={`${viewMode}-${group.label}`}
                    label={group.label}
                    count={group.count}
                    tasks={group.tasks}
                    defaultCollapsed={getDefaultCollapsed(viewMode, group.label, group.count, index)}
                    onMarkComplete={handleMarkComplete}
                    completingTaskId={completingTaskId}
                    completeError={completeError}
                  />
                ))
              )}
            </>
          )}
        </div>
      </main>
    </div>
    </AuthGate>
  )
}

export default App
