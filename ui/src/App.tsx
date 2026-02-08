import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { AuthGate, useAuth } from './auth'
import { TaskGroup } from './components/TaskGroup'
import { ViewSwitcher } from './components/ViewSwitcher'
import { FilterBar } from './components/FilterBar'
import { ChatPanel } from './components/Chat/ChatPanel'
import { listAllTasks, refreshAllTasks, markActionComplete, markEmailComplete } from './api/client'
import { useMCP } from './mcp'
import type { Task, ViewMode, FilterState } from './types/tasks'
import { DEFAULT_FILTERS } from './types/tasks'
import { applyFilters, getTaskIdentifier } from './utils/taskHelpers'
import { groupTasks } from './utils/taskGrouping'
import { formatTime, formatDate, isToday } from './utils/dateHelpers'
import './App.css'

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
  const { login, logout } = useAuth()
  const { isConnected } = useMCP()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('priority')
  const [filterState, setFilterState] = useState<FilterState>(DEFAULT_FILTERS)
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null)
  const [completeError, setCompleteError] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [authErrors, setAuthErrors] = useState<string[]>([])
  const [authErrorsDismissed, setAuthErrorsDismissed] = useState(false)

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const result = await listAllTasks()
      setTasks(result.tasks)
      setFetchedAt(result.fetchedAt)
      setAuthErrors(result.authErrors)
      setAuthErrorsDismissed(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleRefresh = useCallback(async () => {
    try {
      setRefreshing(true)
      setError(null)
      const result = await refreshAllTasks()
      setTasks(result.tasks)
      setFetchedAt(result.fetchedAt)
      setAuthErrors(result.authErrors)
      setAuthErrorsDismissed(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh tasks')
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  // When MCP connects (e.g. after reauth), auto-refresh to replace stale cached data
  const hasAutoRefreshed = useRef(false)
  useEffect(() => {
    if (isConnected && !hasAutoRefreshed.current && authErrors.length > 0) {
      hasAutoRefreshed.current = true
      handleRefresh()
    }
  }, [isConnected, authErrors, handleRefresh])

  const filteredTasks = useMemo(() => applyFilters(tasks, filterState), [tasks, filterState])
  const taskGroups = useMemo(() => groupTasks(filteredTasks, viewMode), [filteredTasks, viewMode])

  const handleMarkComplete = useCallback(async (task: Task) => {
    setCompletingTaskId(task.taskId)
    setCompleteError(null)
    try {
      if (task.source === 'gmail') {
        // Gmail needs OAuth token exchange — route through MCP tool
        const emailId = getTaskIdentifier(task)
        await markEmailComplete(emailId)
      } else {
        // Slack, meeting-notes, docs — use no-auth REST endpoint
        const source = task.source === 'meeting-notes' ? 'meeting-note' : task.source
        const identifier = getTaskIdentifier(task)
        await markActionComplete(source, identifier, task.taskId)
      }
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
    : null

  return (
    <AuthGate>
    <div className={`app-layout ${chatOpen ? 'app-layout--chat-open' : ''}`}>
      <div className="app">
        <header className="app-header">
          <div className="app-header__content">
            <div className="app-header__banner">
              <img src="/logo.svg" alt="" className="app-header__logo" />
              <div className="app-header__text">
                <div className="app-header__top">
                  <h1 className="app-brand">PLAN MY <span className="app-brand__to">TO</span>DAY</h1>
                  <div className="app-header__actions">
                    <button
                      className="app-header__reload"
                      onClick={isConnected ? handleRefresh : fetchTasks}
                      disabled={loading || refreshing}
                      title={isConnected ? 'Fetch fresh data from all sources' : 'Reload from latest snapshot'}
                    >
                      {refreshing ? 'Fetching fresh data...' : loading ? 'Loading...' : 'Refresh'}
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
                  {loading ? 'Loading...' : tasks.length > 0 ? `${tasks.length} tasks across all sources` : ''}
                </p>
                {snapshotLabel && (
                  <p className="app-header__snapshot">
                    {snapshotLabel}
                    {!loading && !refreshing && (
                      <> — {isConnected ? 'click Refresh to fetch latest data' : 'ask your agent to capture a fresh list'}</>
                    )}
                  </p>
                )}
              </div>
            </div>
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

        {authErrors.length > 0 && !authErrorsDismissed && (
          <div className="auth-error-banner">
            <div className="auth-error-banner__content">
              <div className="auth-error-banner__message">
                <strong>Some sources couldn't be reached.</strong>
                {' '}Your authorization grants may have expired or been revoked.
                <details className="auth-error-banner__details">
                  <summary>{authErrors.length} source {authErrors.length === 1 ? 'error' : 'errors'}</summary>
                  <pre className="auth-error-banner__pre">{authErrors.join('\n\n')}</pre>
                </details>
              </div>
              <div className="auth-error-banner__actions">
                <button
                  className="auth-error-banner__reauth btn--inverted"
                  onClick={login}
                >
                  Reauthorize
                </button>
                <button
                  className="auth-error-banner__dismiss"
                  onClick={() => setAuthErrorsDismissed(true)}
                  aria-label="Dismiss"
                >
                  &times;
                </button>
              </div>
            </div>
          </div>
        )}

        <main className="app-main">
          <div className="app-content">
            {loading && (
              <p className="app-status-message">
                Fetching tasks from all sources...
              </p>
            )}

            {!loading && (error || tasks.length === 0) && (
              <div className="app-empty-state">
                {authErrors.length > 0 ? (
                  <>
                    <p>
                      <strong>Couldn't reach some sources.</strong>
                    </p>
                    <p>Your grants may have expired. Reauthorize to refresh them, then try again.</p>
                    <button className="auth-error-banner__reauth btn--inverted" onClick={login}>
                      Reauthorize
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      <strong>No task data available.</strong>
                    </p>
                    <p>Open the chat and ask your agent to plan your day. The dashboard will populate once tasks are fetched.</p>
                  </>
                )}
              </div>
            )}

            {!loading && tasks.length > 0 && (
              <>
                {filteredTasks.length === 0 ? (
                  <p className="app-status-message">
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

      <ChatPanel
        isOpen={chatOpen}
        onToggle={() => setChatOpen((o) => !o)}
        onTasksUpdated={fetchTasks}
      />
    </div>
    </AuthGate>
  )
}

export default App
