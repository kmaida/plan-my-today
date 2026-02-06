// API Client for Todo MCP Server

import type {
  Task,
  MarkCompleteResponse,
  ServerTasksResponse,
} from '../types/tasks'
import { transformServerResponse } from './transformers'
import { mockServerResponse } from './mockData'

// Set VITE_USE_MOCK=true in .env to force mock data during UI-only development
const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

const API_BASE = import.meta.env.VITE_API_BASE || '/api'

/**
 * Generic API call wrapper with error handling
 */
async function apiCall<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`API Error (${response.status}): ${error}`)
    }

    const data = await response.json()
    return data as T
  } catch (error) {
    console.error(`API call failed for ${endpoint}:`, error)
    throw error
  }
}

/**
 * Call an MCP tool via the REST API
 */
async function callTool<T>(toolName: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await apiCall<{ content: Array<{ type: string; text?: string }> }>(
    `/tools/${toolName}`,
    {
      method: 'POST',
      body: JSON.stringify(params),
    }
  )

  // Extract text content from MCP response
  const textContent = response.content?.find((c) => c.type === 'text')?.text

  if (!textContent) {
    throw new Error(`No text content in response from ${toolName}`)
  }

  try {
    return JSON.parse(textContent) as T
  } catch {
    // If not JSON, return as-is
    return textContent as T
  }
}

// ===== Public API Methods =====

export interface TasksResult {
  tasks: Task[]
  fetchedAt: string | null // ISO timestamp from server, null if using mock data
}

/**
 * Fetch all tasks from all sources with enrichment data.
 * Reads the cached JSON file written by the list-all-tasks-today tool
 * each time Claude calls it. Falls back to mock data in dev mode.
 */
export async function listAllTasks(): Promise<TasksResult> {
  if (!USE_MOCK) {
    try {
      const response = await apiCall<ServerTasksResponse>('/tasks')
      return {
        tasks: transformServerResponse(response),
        fetchedAt: response.metadata?.fetched_at || null,
      }
    } catch {
      // No cached data yet — fall through to mock
    }
  }
  return {
    tasks: transformServerResponse(mockServerResponse),
    fetchedAt: null,
  }
}

/**
 * Fetch calendar events for today
 */
export async function listCalendarEvents(): Promise<Task[]> {
  const response = await callTool<{ events: Task[] }>('list-calendar-events')
  return response.events || []
}

/**
 * Fetch Linear issues assigned to user
 */
export async function listLinearIssues(): Promise<Task[]> {
  const response = await callTool<{ issues: Task[] }>('list-linear-issues')
  return response.issues || []
}

/**
 * Fetch Gmail todos (unread/starred)
 */
export async function listGmailTodos(): Promise<Task[]> {
  const response = await callTool<{ emails: Task[] }>('list-gmail-todos')
  return response.emails || []
}

/**
 * Fetch GitHub PRs and issues
 */
export async function listGitHubTodos(): Promise<Task[]> {
  const response = await callTool<{ items: Task[] }>('list-github-todos')
  return response.items || []
}

/**
 * Fetch Slack mentions and DMs
 */
export async function listSlackTodos(): Promise<Task[]> {
  const response = await callTool<{ messages: Task[] }>('list-slack-todos')
  return response.messages || []
}

/**
 * Fetch assigned actions from Google Docs
 */
export async function listAssignedActions(): Promise<Task[]> {
  const response = await callTool<{ actions: Task[] }>('list-assigned-actions')
  return response.actions || []
}

/**
 * Mark an email as complete (adds "Complete" label)
 */
export async function markEmailComplete(emailId: string): Promise<MarkCompleteResponse> {
  return await callTool<MarkCompleteResponse>('mark-email-complete', {
    emailId,
  })
}

/**
 * Mark an action as complete (stores in local completion tracking)
 */
export async function markActionComplete(
  source: string,
  identifier: string
): Promise<MarkCompleteResponse> {
  return await callTool<MarkCompleteResponse>('mark-action-complete', {
    source,
    identifier,
  })
}

/**
 * Unmark an action as complete
 */
export async function unmarkActionComplete(
  source: string,
  identifier: string
): Promise<MarkCompleteResponse> {
  return await callTool<MarkCompleteResponse>('unmark-action-complete', {
    source,
    identifier,
  })
}

/**
 * Get authenticated user info
 */
export async function whoami(): Promise<{ user?: string; authenticated: boolean }> {
  return await callTool<{ user?: string; authenticated: boolean }>('whoami')
}

/**
 * Check authentication status
 */
export async function checkAuth(): Promise<{ authenticated: boolean; message: string }> {
  return await callTool<{ authenticated: boolean; message: string }>('check-auth')
}

// ===== Export all methods =====

export const api = {
  listAllTasks,
  listCalendarEvents,
  listLinearIssues,
  listGmailTodos,
  listGitHubTodos,
  listSlackTodos,
  listAssignedActions,
  markEmailComplete,
  markActionComplete,
  unmarkActionComplete,
  whoami,
  checkAuth,
}

export default api
