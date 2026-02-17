import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react'
import { AuthGate, AuthHint, useAuth } from './auth'
import { TaskGroup } from './components/TaskGroup'
import { ViewSwitcher } from './components/ViewSwitcher'
import { FilterBar } from './components/FilterBar'
import { TodaygentMascot } from './components/Chat/TodaygentMascot'
import { AppLogo } from './components/AppLogo'
import { listAllTasks, refreshAllTasks, dismissTask, restoreDismissedTask } from './api/client'
import { mergeAuthErrors } from './chat/tool-round-utils'
import { useMCP } from './mcp'
import { useTheme } from './hooks/useTheme'
import type { Task, TaskSource, ViewMode, FilterState } from './types/tasks'
import { DEFAULT_FILTERS, isSlackTask } from './types/tasks'
import { applyFilters, getTaskIdentifier, normalizeSource } from './utils/taskHelpers'
import { groupTasks, sourceToGroupSlug, labelToSlug } from './utils/taskGrouping'
import { formatTime, formatDate, isToday } from './utils/dateHelpers'
import { SourceIcon, getSourceLabel } from './components/SourceIcon'
import { Toast } from './components/Toast'
import { Chevron } from './components/Chevron'
import './App.css'

const ChatPanel = lazy(() => import('./components/Chat/ChatPanel'))

const CHAT_TOGGLE_LABELS = [
  'Ask Todaygent',
  'Plan my day',
  'Need a plan?',
  'Talk to Todaygent',
  'Get organized',
  'Summon Todaygent',
  'Deploy Todaygent',
]

function getDefaultCollapsed(viewMode: ViewMode, groupLabel: string, groupCount: number, groupIndex: number): boolean {
  if (viewMode === 'priority') {
    if (groupLabel === 'Low') return true
    if (groupLabel === 'Medium' && groupCount > 5) return true
    return false
  }
  // Other views: collapse groups past index 2
  return groupIndex > 2
}

/** Auto-refresh when the user returns to the tab after this threshold. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Fixed display order for source status pills (stable layout across fetches).
 * Grouped by information type: scheduled → tracked work → communication → reference.
 */
const SOURCE_ORDER: TaskSource[] = [
  'calendar',        // scheduled events (time-bound)
  'linear',          // tracked work (assigned)
  'github',          // tracked work (code)
  'gmail',           // communication (inbound)
  'slack',           // communication (messages)
  'meeting-notes',   // reference (extracted actions)
  'drive',           // reference (Drive mentions)
]

/**
 * Cycling header phrases shown while fetching tasks.
 * Source-themed phrases appear ~86% of the time; easter eggs ~14%.
 */
const SOURCE_PHRASES = [
  'Checking calendar', 'Scanning Linear', 'Reading emails',
  'Browsing Slack', 'Pulling GitHub activity', 'Reviewing meeting notes',
  'Gathering tasks', 'Rounding up to-dos', 'Sorting priorities',
  'Collecting action items',
]

const EASTER_EGG_PHRASES = [
  'Reticulating splines',           // The Sims
  'Inserting chaos generator',       // The Sims
  'Constructing additional pylons',  // StarCraft
  'Rolling for initiative',          // D&D / Baldur's Gate
  'Calibrating flux capacitor',      // Back to the Future
  'Following the white rabbit',      // The Matrix
  'Consulting the cloud',
  'Compiling excuses',
  'Herding cats',
  'Untangling dependencies',
  'Spinning up hamster wheels',
  'Bribing the task gods',
  'Warming up the to-do engine',
]

/** Weighted pool: source ×8 (~86%) + easter eggs ×1 (~14%). */
const FETCH_PHRASE_POOL = [
  ...Array(8).fill(SOURCE_PHRASES).flat(),
  ...EASTER_EGG_PHRASES,
]

/** Pick a random phrase different from the current one (avoids stuttering). */
function pickPhrase(current: string): string {
  let next = current
  let attempts = 0
  while (next === current && attempts < 10) {
    next = FETCH_PHRASE_POOL[Math.floor(Math.random() * FETCH_PHRASE_POOL.length)]
    attempts++
  }
  return next
}

function App() {
  const { login, logout, isLoggingIn } = useAuth()
  const { isConnected, connectionLost, reconnect } = useMCP()
  const { theme, effectiveTheme, setTheme } = useTheme()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('priority')
  const [scrollToSource, setScrollToSource] = useState<TaskSource | null>(null)
  const [filterState, setFilterState] = useState<FilterState>(DEFAULT_FILTERS)
  const [dismissingTaskIds, setDismissingTaskIds] = useState<Set<string>>(new Set())
  const [dismissError, setDismissError] = useState<string | null>(null)
  const [exitingTaskIds, setExitingTaskIds] = useState<Set<string>>(new Set())
  const [restoredTaskId, setRestoredTaskId] = useState<string | null>(null)
  /** Stash dismiss metadata per task so each onExitComplete resolves independently */
  const pendingDismissMap = useRef<Map<string, { task: Task; source: string; identifier: string }>>(new Map())
  const [chatOpen, setChatOpen] = useState(false)
  const chatToggleRef = useRef<HTMLButtonElement>(null)
  const prevChatOpenRef = useRef(chatOpen)
  const [chatToggleLabel] = useState(() => CHAT_TOGGLE_LABELS[Math.floor(Math.random() * CHAT_TOGGLE_LABELS.length)])
  const [authErrors, setAuthErrors] = useState<string[]>([])
  const [failedSources, setFailedSources] = useState<string[]>([])
  const [authErrorsDismissed, setAuthErrorsDismissed] = useState(false)
  const [authErrorsExpanded, setAuthErrorsExpanded] = useState(false)
  const [dismissedInfo, setDismissedInfo] = useState<{ task: Task; source: string; identifier: string } | null>(null)
  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const result = await listAllTasks()
      setTasks(result.tasks)
      setFetchedAt(result.fetchedAt)
      setAuthErrors(result.authErrors)
      setFailedSources(result.failedSources)
      setAuthErrorsDismissed(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  /** Deduplicate concurrent refresh calls (MCP connect + tab-focus + manual click). */
  const inflightRefreshRef = useRef<Promise<void> | null>(null)

  const handleRefresh = useCallback(async () => {
    if (inflightRefreshRef.current) return inflightRefreshRef.current

    const doRefresh = async () => {
      try {
        setRefreshing(true)
        setError(null)
        const result = await refreshAllTasks()
        setTasks(result.tasks)
        setFetchedAt(result.fetchedAt)
        setAuthErrors(result.authErrors)
        setFailedSources(result.failedSources)
        setAuthErrorsDismissed(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to refresh tasks')
      } finally {
        setRefreshing(false)
        inflightRefreshRef.current = null
      }
    }

    inflightRefreshRef.current = doRefresh()
    return inflightRefreshRef.current
  }, [])

  /**
   * Single callback for ChatPanel after each chat turn completes.
   * - Refreshes the dashboard when list-all-tasks-today wrote fresh task store data.
   * - Shows the reauth banner when any tool hit an auth error. Two sources:
   *   1. MCP isError flag (individual tool failures caught by evaluateToolRound)
   *   2. metadata.errors in the task store (partial failures from list-all-tasks-today)
   */
  const handleToolCallsComplete = useCallback(async (result: { didFetchAllTasks: boolean; authErrors: string[] }) => {
    let storeErrors: string[] = []
    if (result.didFetchAllTasks) {
      try {
        const stored = await listAllTasks()
        setTasks(stored.tasks)
        setFetchedAt(stored.fetchedAt)
        storeErrors = stored.authErrors
        setFailedSources(stored.failedSources)
      } catch {
        // Non-fatal: task store read failed, tasks stay as-is
      } finally {
        // Stop the header loading animation that onFetchStarted triggered
        setRefreshing(false)
      }
    }
    if (result.authErrors.length > 0 || storeErrors.length > 0) {
      setAuthErrors((prev) => mergeAuthErrors(prev, result.authErrors, storeErrors))
      setAuthErrorsDismissed(false)
    }
  }, [])

  // Restore the last task snapshot on mount when a chat session exists, so the
  // dashboard stays consistent with the restored conversation. Reads cached
  // task store JSON only (no API calls). Skipped during reauth — the reauth
  // effect below fetches fresh data and needs the empty-task loading skeleton.
  useEffect(() => {
    const hasChatSession = sessionStorage.getItem("chat_state") !== null;
    const isPendingReauth = sessionStorage.getItem("pending_refresh") !== null;
    if (hasChatSession && !isPendingReauth) {
      listAllTasks()
        .then((result) => {
          setTasks(result.tasks);
          setFetchedAt(result.fetchedAt);
          setAuthErrors(result.authErrors);
          setFailedSources(result.failedSources);
        })
        .catch(() => {
          // Task store read failed — dashboard stays empty, user can fetch manually
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [])

  // Auto-refresh tasks whenever the MCP connection is (re-)established.
  // Covers: initial connect, manual "Reconnect" after server dies, and reauth
  // redirects. On cold start this triggers a live fetch automatically —
  // the user no longer needs to click "Fetch tasks" manually.
  const wasConnected = useRef(isConnected)
  useEffect(() => {
    const justConnected = isConnected && !wasConnected.current
    wasConnected.current = isConnected

    if (justConnected) {
      sessionStorage.removeItem('pending_refresh')
      handleRefresh()
    }
  }, [isConnected, handleRefresh])

  // Return focus to the chat toggle button when the panel closes.
  // The button conditionally mounts (chatOpen ternary), but it exists
  // in the DOM by the time this effect fires (effects run after commit).
  useEffect(() => {
    if (prevChatOpenRef.current && !chatOpen) {
      chatToggleRef.current?.focus()
    }
    prevChatOpenRef.current = chatOpen
  }, [chatOpen])

  // Auto-refresh on tab focus when data is stale.
  // Refs mirror state so the visibilitychange listener stays stable
  // (no re-registration on every fetch cycle).
  const fetchedAtRef = useRef(fetchedAt)
  fetchedAtRef.current = fetchedAt
  const refreshingRef = useRef(refreshing)
  refreshingRef.current = refreshing

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const ts = fetchedAtRef.current
      if (!ts || refreshingRef.current) return
      if (Date.now() - new Date(ts).getTime() > STALE_THRESHOLD_MS) {
        handleRefresh()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [handleRefresh])

  // Cycling fetch phrases — shown in the subtitle row while fetching tasks.
  // Reuses the same fade+swap pattern as ThinkingIndicator.
  const [fetchPhrase, setFetchPhrase] = useState(() => pickPhrase(''))
  const [phraseFading, setPhraseFading] = useState(false)
  const showCycling = refreshing
  const showDimmed = refreshing && tasks.length > 0

  const cyclePhrase = useCallback(() => {
    setPhraseFading(true)
    setTimeout(() => {
      setFetchPhrase((prev) => pickPhrase(prev))
      setPhraseFading(false)
    }, 200)
  }, [])

  useEffect(() => {
    if (!showCycling) return
    // Pick a fresh phrase immediately when cycling starts
    setFetchPhrase((prev) => pickPhrase(prev))
    setPhraseFading(false)
    const interval = setInterval(cyclePhrase, 2300)
    return () => clearInterval(interval)
  }, [showCycling, cyclePhrase])

  // Per-source task counts for the header pills
  const sourceCounts = useMemo(() => {
    const counts = new Map<TaskSource, number>()
    for (const task of tasks) {
      const src = normalizeSource(task.source)
      counts.set(src, (counts.get(src) ?? 0) + 1)
    }
    return counts
  }, [tasks])

  /** Click a header source pill → switch to source view and scroll to that section. */
  const handleSourcePillClick = useCallback((source: TaskSource) => {
    setViewMode("source")
    setScrollToSource(source)
  }, [])

  // Scroll to the target source group after React commits the source-view DOM
  useEffect(() => {
    if (!scrollToSource) return
    const slug = sourceToGroupSlug(scrollToSource)
    // Defer to next frame so layout is finalized (needed when switching views)
    const rafId = requestAnimationFrame(() => {
      const el = appElRef.current?.querySelector<HTMLElement>(`[data-group="${slug}"]`)
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
      setScrollToSource(null)
    })
    return () => cancelAnimationFrame(rafId)
  }, [scrollToSource])

  const filteredTasks = useMemo(() => applyFilters(tasks, filterState), [tasks, filterState])
  const taskGroups = useMemo(() => groupTasks(filteredTasks, viewMode), [filteredTasks, viewMode])
  const targetSlug = scrollToSource ? sourceToGroupSlug(scrollToSource) : null

  const handleDismiss = useCallback(async (task: Task) => {
    setDismissingTaskIds(prev => new Set(prev).add(task.taskId))
    setDismissError(null)
    try {
      // Meeting-notes, docs, slack — use no-auth REST endpoint (local completion store)
      const source = task.source === 'meeting-notes' ? 'meeting-note' : task.source
      const identifier = getTaskIdentifier(task)
      // Pass slackType for defense-in-depth: server rejects emoji-saved messages
      const slackType = isSlackTask(task) ? task.type : undefined
      await dismissTask(source, identifier, task.taskId, slackType)
      // Stash info and trigger exit animation — actual removal happens in onExitComplete
      pendingDismissMap.current.set(task.taskId, { task, source, identifier })
      setExitingTaskIds(prev => new Set(prev).add(task.taskId))
    } catch (err) {
      console.error('Failed to dismiss task:', err)
      setDismissError(task.taskId)
    } finally {
      setDismissingTaskIds(prev => {
        const next = new Set(prev)
        next.delete(task.taskId)
        return next
      })
    }
  }, [])

  /** Called by TaskCard after its collapse animation finishes */
  const handleExitComplete = useCallback((taskId: string) => {
    const info = pendingDismissMap.current.get(taskId)
    if (!info) return
    setTasks(prev => prev.filter(t => t !== info.task))
    // Toast shows the most recently dismissed task (last one wins for undo)
    setDismissedInfo(info)
    setExitingTaskIds(prev => {
      const next = new Set(prev)
      next.delete(taskId)
      return next
    })
    pendingDismissMap.current.delete(taskId)
  }, [])

  const handleUndoDismiss = useCallback(async () => {
    if (!dismissedInfo) return
    const { task, source, identifier } = dismissedInfo
    try {
      await restoreDismissedTask(source, identifier)
      // Re-insert into the task list with restore animation marker
      setRestoredTaskId(task.taskId)
      setTasks(prev => [...prev, task].sort((a, b) => b.priorityMetadata.score - a.priorityMetadata.score))
      setDismissedInfo(null)
      // Clear the marker after the component has mounted and captured it
      setTimeout(() => setRestoredTaskId(null), 50)
    } catch (err) {
      console.error('Failed to restore task:', err)
      // Toast stays visible so the user can retry
    }
  }, [dismissedInfo])

  const snapshotLabel = fetchedAt
    ? `Last updated ${isToday(fetchedAt) ? 'today' : formatDate(fetchedAt)} at ${formatTime(fetchedAt)}`
    : null

  // Back-to-top: track scroll position on the .app container.
  // Uses a callback ref because AuthGate defers rendering children
  // until auth resolves, so a plain useEffect([]) would miss the element.
  const appElRef = useRef<HTMLDivElement | null>(null)
  const [showBackToTop, setShowBackToTop] = useState(false)

  const appRef = useCallback((el: HTMLDivElement | null) => {
    // Clean up previous listener
    if (appElRef.current) {
      appElRef.current.removeEventListener("scroll", handleAppScroll)
    }
    appElRef.current = el
    if (el) {
      el.addEventListener("scroll", handleAppScroll, { passive: true })
    }
  }, [])

  function handleAppScroll(this: HTMLDivElement) {
    setShowBackToTop(this.scrollTop > 200)
  }

  const scrollToTop = () => {
    appElRef.current?.scrollTo({ top: 0, behavior: "smooth" })
  }

  return (
    <AuthGate>
    <div className={`app-layout ${chatOpen ? 'app-layout--chat-open' : ''}`}>
      <div className="app" ref={appRef}>
        <header className="app-header">
          <div className="app-header__content">
            <div className="app-header__banner">
              <AppLogo animated={loading || refreshing} className="app-header__logo" />
              <div className="app-header__text">
                <div className="app-header__top">
                  <h1 className="app-brand">PLAN MY <span className="app-brand__to">TO</span>DAY</h1>
                  <div className="app-header__actions">
                    <div className="theme-switcher" role="radiogroup" aria-label="Theme">
                      <button
                        className={`theme-switcher__option${theme === 'light' ? ' theme-switcher__option--active' : ''}`}
                        onClick={() => setTheme('light')}
                        title="Light"
                        aria-label="Light theme"
                        role="radio"
                        aria-checked={theme === 'light'}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="5"/>
                          <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                          <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                        </svg>
                      </button>
                      <button
                        className={`theme-switcher__option${theme === 'system' ? ' theme-switcher__option--active' : ''}`}
                        onClick={() => setTheme('system')}
                        title="System"
                        aria-label="System theme"
                        role="radio"
                        aria-checked={theme === 'system'}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                        </svg>
                      </button>
                      <button
                        className={`theme-switcher__option${theme === 'dark' ? ' theme-switcher__option--active' : ''}`}
                        onClick={() => setTheme('dark')}
                        title="Dark"
                        aria-label="Dark theme"
                        role="radio"
                        aria-checked={theme === 'dark'}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                        </svg>
                      </button>
                    </div>
                    <button
                      className="app-header__logout"
                      onClick={logout}
                      title="Disconnect"
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
                <div className="app-header__subtitle-row">
                  {showCycling && (
                    <div className="app-header__subtitle app-header__subtitle--cycling">
                      <span className={phraseFading ? 'app-header__phrase--fading' : ''}>
                        {fetchPhrase}...
                      </span>
                    </div>
                  )}
                  {!showCycling && (loading || tasks.length > 0) && (
                    <div className="app-header__subtitle">
                      {loading ? 'Loading...' : (
                        <>
                          {tasks.length} tasks
                          {sourceCounts.size > 0 && (
                            <span className="source-status">
                              {SOURCE_ORDER.filter(src => sourceCounts.has(src)).map(src => (
                                <span key={src} className="source-status__item">
                                  <button
                                    className="source-status__pill"
                                    onClick={() => handleSourcePillClick(src)}
                                    title={`View ${getSourceLabel(src)} tasks`}
                                  >
                                    <SourceIcon source={src} size={12} />
                                    {sourceCounts.get(src)}
                                  </button>
                                </span>
                              ))}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  <button
                    className="app-header__reload"
                    onClick={isConnected ? handleRefresh : fetchTasks}
                    disabled={loading || refreshing}
                    title={isConnected ? 'Fetch fresh data from all sources' : 'Reload from latest snapshot'}
                  >
                    {refreshing ? 'Fetching...' : loading ? 'Loading...' : 'Fetch tasks'}
                  </button>
                </div>
                {snapshotLabel && (
                  <p className={`app-header__snapshot${showDimmed ? ' app-header__snapshot--dimmed' : ''}`}>{snapshotLabel}</p>
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
                {' '}Your authorization grants may have expired or been revoked. Reauthorizing will refresh all expired source connections. <AuthHint />
              </div>
              <div className="auth-error-banner__actions">
                <button
                  className="auth-error-banner__reauth"
                  onClick={() => login({ reauth: true })}
                  disabled={isLoggingIn}
                >
                  {isLoggingIn ? 'Redirecting...' : 'Reauthorize'}
                </button>
              </div>
              <div className="auth-error-banner__details">
                <button
                  className="auth-error-banner__toggle"
                  onClick={() => setAuthErrorsExpanded(prev => !prev)}
                >
                  <Chevron direction={authErrorsExpanded ? 'down' : 'right'} size={10} />
                  {authErrors.length} source {authErrors.length === 1 ? 'error' : 'errors'}
                  {failedSources.length > 0 && `: ${failedSources.map(s => getSourceLabel(s as TaskSource)).join(', ')}`}
                </button>
                <div className={`auth-error-banner__collapse${authErrorsExpanded ? ' auth-error-banner__collapse--open' : ''}`}>
                  <div className="auth-error-banner__collapse-inner">
                    <pre className="auth-error-banner__pre">{authErrors.join('\n\n')}</pre>
                  </div>
                </div>
              </div>
            </div>
            <button
              className="auth-error-banner__dismiss"
              onClick={() => setAuthErrorsDismissed(true)}
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        )}

        {connectionLost && (
          <div className="connection-banner">
            <span className="connection-banner__message">
              Connection lost.
            </span>
            <button className="connection-banner__action" onClick={reconnect}>
              Reconnect
            </button>
          </div>
        )}

        <main className="app-main">
          <div className="app-content">
            {(loading || (refreshing && tasks.length === 0)) && (
              <div className="app-loading">
                <p className="app-loading__text">
                  {sessionStorage.getItem('pending_refresh') ? 'Restoring tasks...' : 'Fetching tasks...'}
                </p>
              </div>
            )}

            {!loading && !refreshing && error && tasks.length === 0 && (
              <div className="app-empty-state">
                <p className="app-empty-state__heading">
                  Something went wrong.
                </p>
                <p className="app-empty-state__error">{error}</p>
                <div className="app-empty-state__actions">
                  <button
                    className="app-empty-state__fetch-btn"
                    onClick={isConnected ? handleRefresh : fetchTasks}
                    disabled={loading || refreshing}
                  >
                    Try again
                  </button>
                  <button className="app-empty-state__chat-btn" onClick={() => setChatOpen(true)}>
                    <svg className="app-empty-state__sparkle" viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="12" fill="#3D2E1F"/>
                      {effectiveTheme === 'dark' ? (
                        <path d="M10.4,14 L12,20 L13.6,14 L20,12 L13.6,10 L12,4 L10.4,10 L4,12 Z" fill="#FFBF2E"/>
                      ) : (
                        <>
                          <path d="M10.5,15 L11.5,18.5 L12.5,15 L16,14 L12.5,13 L11.5,9.5 L10.5,13 L7,14 Z" fill="#FFBF2E"/>
                          <path d="M16,11.5 L16.8,14 L17.6,11.5 L20,10.7 L17.6,9.9 L16.8,7.5 L16,9.9 L13.5,10.7 Z" fill="#FFBF2E"/>
                          <path d="M6.5,11 L7.2,12.6 L7.9,11 L9.5,10.4 L7.9,9.8 L7.2,8.2 L6.5,9.8 L5,10.4 Z" fill="#FFBF2E"/>
                        </>
                      )}
                    </svg>
                    Ask Todaygent
                  </button>
                </div>
              </div>
            )}

            {!loading && !refreshing && !error && tasks.length === 0 && (
              <div className="app-empty-state">
                <p className="app-empty-state__heading">
                  Ready when you are.
                </p>
                <p>Fetch your tasks to populate the dashboard, or ask Todaygent to plan your day.</p>
                <div className="app-empty-state__actions">
                  <button
                    className="app-empty-state__fetch-btn"
                    onClick={isConnected ? handleRefresh : fetchTasks}
                    disabled={loading || refreshing}
                  >
                    Fetch tasks
                  </button>
                  <button className="app-empty-state__chat-btn" onClick={() => setChatOpen(true)}>
                    <svg className="app-empty-state__sparkle" viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="12" fill="#3D2E1F"/>
                      {effectiveTheme === 'dark' ? (
                        <path d="M10.4,14 L12,20 L13.6,14 L20,12 L13.6,10 L12,4 L10.4,10 L4,12 Z" fill="#FFBF2E"/>
                      ) : (
                        <>
                          <path d="M10.5,15 L11.5,18.5 L12.5,15 L16,14 L12.5,13 L11.5,9.5 L10.5,13 L7,14 Z" fill="#FFBF2E"/>
                          <path d="M16,11.5 L16.8,14 L17.6,11.5 L20,10.7 L17.6,9.9 L16.8,7.5 L16,9.9 L13.5,10.7 Z" fill="#FFBF2E"/>
                          <path d="M6.5,11 L7.2,12.6 L7.9,11 L9.5,10.4 L7.9,9.8 L7.2,8.2 L6.5,9.8 L5,10.4 Z" fill="#FFBF2E"/>
                        </>
                      )}
                    </svg>
                    Ask Todaygent
                  </button>
                </div>
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
                        forceExpanded={targetSlug !== null && targetSlug === labelToSlug(group.label)}
                        onDismiss={handleDismiss}
                        dismissingTaskIds={dismissingTaskIds}
                        dismissError={dismissError}
                        exitingTaskIds={exitingTaskIds}
                        restoredTaskId={restoredTaskId}
                        onExitComplete={handleExitComplete}
                      />
                  ))
                )}
              </>
            )}
          </div>
        </main>
      </div>

      <button
        className={`back-to-top${showBackToTop ? " back-to-top--visible" : ""}`}
        onClick={scrollToTop}
        title="Back to top"
        aria-label="Back to top"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>

      {chatOpen ? (
        <Suspense fallback={null}>
          <ChatPanel
            isOpen={chatOpen}
            onToggle={() => setChatOpen(false)}
            onToolCallsComplete={handleToolCallsComplete}
            onFetchStarted={() => setRefreshing(true)}
          />
        </Suspense>
      ) : (
        <button ref={chatToggleRef} className="chat-toggle" onClick={() => setChatOpen(true)} title="Open chat">
          <TodaygentMascot state="idle" size={40} className="chat-toggle__mascot" />
          <span className="chat-toggle__label">{chatToggleLabel}</span>
        </button>
      )}

      {dismissedInfo && (
        <Toast
          message="Task dismissed"
          actionLabel="Undo"
          onAction={handleUndoDismiss}
          onDismiss={() => setDismissedInfo(null)}
        />
      )}

    </div>
    </AuthGate>
  )
}

export default App
