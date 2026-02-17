// API Client for Todo MCP Server
// Uses the MCP protocol client (set via setMCPCallTool) when available,
// falls back to REST API for non-auth endpoints (/api/tasks, /api/dismiss-task).

import { API_BASE } from "../config";
import type { DismissalResponse, ServerTasksResponse, Task } from "../types/tasks";
import { transformServerResponse } from "./transformers";

// ── MCP client integration ────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK callTool returns dynamically typed results
type MCPCallToolFn = (name: string, args?: Record<string, unknown>) => Promise<any>;

let _mcpCallTool: MCPCallToolFn | null = null;

/** Set the MCP callTool function (called by MCPClientContext on connect/disconnect). */
export function setMCPCallTool(fn: MCPCallToolFn | null): void {
  _mcpCallTool = fn;
}

// ── Timeout ──────────────────────────────────────────────────────────────────

/** Default request timeout (ms). Must accommodate 7-source parallel fetch plus
 *  LLM-augmented meeting note extraction on cold cache (can take 30-40s). */
const REQUEST_TIMEOUT_MS = 60_000;

// ── Bearer token injection (kept for REST endpoints that don't use MCP) ───────

let _authToken: string | null = null;

/** Set the Bearer token used for REST API calls. */
export function setAuthToken(token: string | null): void {
  _authToken = token;
}

/**
 * Generic REST API call wrapper (for non-MCP endpoints)
 */
async function apiCall<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${endpoint}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (_authToken) {
    headers.Authorization = `Bearer ${_authToken}`;
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API Error (${response.status}): ${error}`);
    }

    const data = await response.json();
    return data as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`Request to ${endpoint} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    console.error(`API call failed for ${endpoint}:`, error);
    throw error;
  }
}

/**
 * Call an MCP tool via the MCP protocol client.
 * Extracts text content from the MCP response and parses it as JSON.
 */
async function callTool<T>(toolName: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!_mcpCallTool) {
    throw new Error("MCP client not connected — cannot call tools");
  }

  // The MCP SDK transport doesn't accept AbortSignal, so we use Promise.race
  // with a timeout to prevent hanging indefinitely.
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`MCP tool ${toolName} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    }, REQUEST_TIMEOUT_MS);
  });
  const callPromise = _mcpCallTool(toolName, params);
  const result = await Promise.race([callPromise, timeoutPromise]).finally(() =>
    clearTimeout(timeoutId),
  );

  // Extract text content from MCP response (content array from CallToolResult)
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const textItem = content?.find((c) => c.type === "text");
  const text = textItem?.text;

  if (!text) {
    throw new Error(`No text content in response from ${toolName}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    // If not JSON, return as-is
    return text as T;
  }
}

// ===== Public API Methods =====

export interface TasksResult {
  tasks: Task[];
  fetchedAt: string | null; // ISO timestamp from server, null if using mock data
  authErrors: string[]; // per-source auth failures (e.g. expired grants)
  failedSources: string[]; // source keys that failed (e.g. ["gmail", "slack"])
}

/**
 * Fetch all tasks from all sources with enrichment data.
 * Reads the task store file written by the list-all-tasks-today tool
 * each time the agent calls it. Throws on failure (no mock fallback).
 */
export async function listAllTasks(): Promise<TasksResult> {
  const response = await apiCall<ServerTasksResponse>("/tasks");
  return {
    tasks: transformServerResponse(response),
    fetchedAt: response.metadata?.fetched_at || null,
    authErrors: response.metadata?.errors || [],
    failedSources: response.metadata?.failedSources || [],
  };
}

/**
 * Fetch fresh task data from all sources via the MCP tool.
 * The tool fetches, enriches, and writes to the task store, then returns
 * a lightweight confirmation with counts. We read the full data from the
 * task store via REST after the tool completes.
 * Falls back to task store read if MCP is not connected.
 */
export async function refreshAllTasks(): Promise<TasksResult> {
  if (!_mcpCallTool) {
    return listAllTasks();
  }
  // Trigger fresh fetch + write to task store
  await callTool("list-all-tasks-today", {});
  // Read the freshly written data
  return listAllTasks();
}

/**
 * Dismiss a task from the dashboard (stores in local completion tracking).
 * Calls a dedicated no-auth REST endpoint instead of the MCP tool layer.
 * For Slack tasks, pass slackType so the server can reject emoji-saved messages.
 */
export async function dismissTask(
  source: string,
  identifier: string,
  taskId?: string,
  slackType?: string
): Promise<DismissalResponse> {
  const payload: Record<string, unknown> = { source, identifier, taskId };
  if (slackType) payload.slackType = slackType;
  return await apiCall<DismissalResponse>("/dismiss-task", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Restore a previously dismissed task so it reappears on the dashboard.
 */
export async function restoreDismissedTask(
  source: string,
  identifier: string
): Promise<DismissalResponse> {
  return await apiCall<DismissalResponse>("/restore-dismissed-task", {
    method: "POST",
    body: JSON.stringify({ source, identifier }),
  });
}
