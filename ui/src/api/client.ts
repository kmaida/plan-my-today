// API Client for Todo MCP Server
// Uses the MCP protocol client (set via setMCPCallTool) when available,
// falls back to REST API for non-auth endpoints (/api/tasks, /api/mark-action-complete).

import type {
  Task,
  MarkCompleteResponse,
  ServerTasksResponse,
} from '../types/tasks'
import { transformServerResponse } from './transformers'

const API_BASE = import.meta.env.VITE_API_BASE || '/api'

// ── MCP client integration ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MCPCallToolFn = (name: string, args?: Record<string, unknown>) => Promise<any>

let _mcpCallTool: MCPCallToolFn | null = null

/** Set the MCP callTool function (called by MCPClientContext on connect/disconnect). */
export function setMCPCallTool(fn: MCPCallToolFn | null): void {
  _mcpCallTool = fn
}

// ── Bearer token injection (kept for REST endpoints that don't use MCP) ───────

let _authToken: string | null = null

/** Set the Bearer token used for REST API calls. */
export function setAuthToken(token: string | null): void {
  _authToken = token
}

/**
 * Generic REST API call wrapper (for non-MCP endpoints)
 */
async function apiCall<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }

  if (_authToken) {
    headers['Authorization'] = `Bearer ${_authToken}`
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
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
 * Call an MCP tool via the MCP protocol client.
 * Extracts text content from the MCP response and parses it as JSON.
 */
async function callTool<T>(toolName: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!_mcpCallTool) {
    throw new Error('MCP client not connected — cannot call tools')
  }

  const result = await _mcpCallTool(toolName, params)

  // Extract text content from MCP response (content array from CallToolResult)
  const content = result.content as Array<{ type: string; text?: string }> | undefined
  const textItem = content?.find((c) => c.type === 'text')
  const text = textItem?.text

  if (!text) {
    throw new Error(`No text content in response from ${toolName}`)
  }

  try {
    return JSON.parse(text) as T
  } catch {
    // If not JSON, return as-is
    return text as T
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
 * each time the agent calls it. Throws on failure (no mock fallback).
 */
export async function listAllTasks(): Promise<TasksResult> {
  const response = await apiCall<ServerTasksResponse>('/tasks')
  return {
    tasks: transformServerResponse(response),
    fetchedAt: response.metadata?.fetched_at || null,
  }
}

/**
 * Fetch fresh task data from all sources via the MCP tool.
 * Unlike listAllTasks() (which reads cached JSON), this triggers
 * actual API calls to Calendar, Linear, Gmail, etc.
 * Falls back to cache read if MCP is not connected.
 */
export async function refreshAllTasks(): Promise<TasksResult> {
  if (!_mcpCallTool) {
    return listAllTasks()
  }
  const response = await callTool<ServerTasksResponse>('list-all-tasks-today', { compact: false })
  return {
    tasks: transformServerResponse(response),
    fetchedAt: response.metadata?.fetched_at || null,
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
 * Mark an action as complete (stores in local completion tracking).
 * Calls a dedicated no-auth REST endpoint instead of the MCP tool layer.
 */
export async function markActionComplete(
  source: string,
  identifier: string,
  taskId?: string
): Promise<MarkCompleteResponse> {
  return await apiCall<MarkCompleteResponse>('/mark-action-complete', {
    method: 'POST',
    body: JSON.stringify({ source, identifier, complete: true, taskId }),
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
  refreshAllTasks,
  listCalendarEvents,
  listLinearIssues,
  listGmailTodos,
  listGitHubTodos,
  listSlackTodos,
  listAssignedActions,
  markEmailComplete,
  markActionComplete,
  whoami,
  checkAuth,
}

export default api
