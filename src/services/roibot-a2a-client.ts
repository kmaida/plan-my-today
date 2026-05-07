/**
 * A2A client for delegating tasks from Todaygent to ROIbot.
 *
 * Replaces the previous MCP-proxy approach (`roibot-client.ts`,
 * `roibot-delegate.ts`) with agent-to-agent task delegation per the
 * A2A protocol. Todaygent hands off a free-form task description to
 * ROIbot's `/api/agent` endpoint; ROIbot's own LLM picks tools and
 * returns a coherent reply. Todaygent's LLM never knows ROIbot's
 * tool names — by design.
 *
 * @remarks
 * **RFC 8693 token exchange happens on every call**, not cached.
 * HITL pauses can stretch beyond a single token TTL (Kim takes 30s,
 * grabs a coffee, comes back), and a stale cached token would block
 * the resume. Re-exchanging is cheap (Keycard STS keeps its own JWKS
 * cache); always-fresh is correct.
 *
 * **Two distinct entry points** — `startTask` and `resumeTask` — keep
 * the wire-shape obvious at call sites. New tasks send a TextPart;
 * resumes send a structured DataPart with approvals. The dashboard's
 * agent endpoint enforces the shape (rejects free-form text on a
 * continuation), so accidental cross-wiring fails loudly.
 */

import {
  ClientFactory,
  JsonRpcTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { exchangeToken, TokenExchangeError } from "./keycard-client";
import { getLogger } from "../observability/logger";

const logger = getLogger();

/**
 * Error thrown when an A2A delegation call fails. Wraps the underlying
 * cause (often a `TokenExchangeError`) so callers can format clean
 * user-facing messages without string matching.
 */
export class ROIbotA2AClientError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "ROIbotA2AClientError";
    this.cause = cause;
  }
}

/** One Tier-1 tool call ROIbot needs the user to approve or deny. */
export interface PendingToolCall {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
}

/**
 * Outcome of an A2A round-trip. `completed` is the happy path;
 * `input-required` means ROIbot is paused for user approval and
 * carries the `taskId`/`contextId` the caller must echo back to
 * resume; `failed` is a terminal error.
 */
export interface DelegateResult {
  state: "completed" | "input-required" | "failed";
  /** Final agent text, or pending-state description for `input-required`. */
  finalText: string;
  /** Required for resume continuation when `state === 'input-required'`. */
  taskId?: string;
  /** Required for resume continuation when `state === 'input-required'`. */
  contextId?: string;
  /** The Tier-1 actions ROIbot wants approval for. */
  pendingToolCalls?: PendingToolCall[];
}

/** True iff the env var is set; used by tools to short-circuit politely. */
export function isROIbotConfigured(): boolean {
  return !!config.roibotAgentEndpoint;
}

/**
 * Start a NEW A2A task. The first message is a free-form text description;
 * ROIbot picks the right tool internally.
 */
export async function startTask(authInfo: AuthInfo, task: string): Promise<DelegateResult> {
  const client = await buildClient(authInfo);
  const contextId = randomUUID();
  const stream = client.sendMessageStream({
    message: {
      kind: "message",
      messageId: randomUUID(),
      role: "user",
      contextId,
      parts: [{ kind: "text", text: task }],
    },
  });
  return consumeStream(stream);
}

/**
 * Resume an existing A2A task with structured approval decisions.
 *
 * Sends a continuation message carrying a single DataPart with shape
 * `{ approvals: { [toolUseId]: { approved, reason? } } }`. The dashboard
 * rejects continuation messages without this shape, so a misformed call
 * fails loud rather than racing into the orchestrator with bad input.
 */
export async function resumeTask(
  authInfo: AuthInfo,
  taskId: string,
  contextId: string,
  approvals: Record<string, { approved: boolean; reason?: string }>,
): Promise<DelegateResult> {
  const client = await buildClient(authInfo);
  const stream = client.sendMessageStream({
    message: {
      kind: "message",
      messageId: randomUUID(),
      role: "user",
      taskId,
      contextId,
      parts: [
        {
          kind: "data",
          data: { approvals },
        },
      ],
    },
  });
  return consumeStream(stream);
}

/**
 * Build a per-call A2A `Client` with a Bearer-injecting fetch.
 *
 * Re-exchanges the user's session token for a ROIbot-audience token on
 * every call (see file-level @remarks). The `ClientFactory.createFromUrl`
 * call does an agent-card discovery fetch as a side effect — currently
 * unauthenticated on our agent endpoint (per A2A spec § 8) — so the
 * Bearer header is only used for the actual `message/send` call.
 */
async function buildClient(authInfo: AuthInfo): Promise<Client> {
  if (!config.roibotAgentEndpoint) {
    throw new ROIbotA2AClientError(
      "ROIBOT_AGENT_ENDPOINT not configured. Set it to ROIbot's /api/agent " +
        "URL (e.g. https://event-roi.fly.dev/api/agent).",
    );
  }

  let bearer: string;
  try {
    const response = await exchangeToken(authInfo, config.roibotAgentEndpoint);
    bearer = response.accessToken;
  } catch (err) {
    if (err instanceof TokenExchangeError) {
      throw new ROIbotA2AClientError(
        `Token exchange to ROIbot failed: ${err.description ?? err.message}`,
        err,
      );
    }
    throw new ROIbotA2AClientError(
      "Unexpected error exchanging token for ROIbot",
      err instanceof Error ? err : undefined,
    );
  }

  const authFetch: typeof fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${bearer}`);
    return fetch(input, { ...init, headers });
  };

  // Wire the auth-fetch through a JsonRpcTransportFactory so it's used
  // for both agent-card discovery and the message/send call. The
  // factory pattern is the SDK's recommended path; the deprecated
  // `A2AClient` would also work but the SDK pushes `ClientFactory`.
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
  });
  return factory.createFromUrl(config.roibotAgentEndpoint);
}

/**
 * Drain the SSE stream and reduce its events to a single {@link DelegateResult}.
 * Later events win — terminal Task with state='completed' is the canonical
 * "done" signal.
 */
async function consumeStream(
  stream: AsyncGenerator<unknown, void, undefined>,
): Promise<DelegateResult> {
  let state: DelegateResult["state"] = "failed";
  let finalText = "";
  let taskId: string | undefined;
  let contextId: string | undefined;
  let pendingToolCalls: PendingToolCall[] | undefined;

  for await (const event of stream) {
    if (!event || typeof event !== "object") continue;

    const e = event as {
      kind?: string;
      id?: string;
      contextId?: string;
      taskId?: string;
      status?: { state?: string; message?: { parts?: unknown[] } };
      artifact?: { artifactId?: string; name?: string; parts?: unknown[] };
    };

    // Task object — terminal or interim state with full snapshot
    if (e.kind === "task") {
      taskId ??= e.id;
      contextId ??= e.contextId;
      const taskState = e.status?.state;
      if (taskState) state = mapTaskState(taskState);
      const text = extractText(e.status?.message?.parts ?? []);
      if (text) finalText = text;
      continue;
    }

    // status-update — incremental state transition
    if (e.kind === "status-update") {
      taskId ??= e.taskId;
      contextId ??= e.contextId;
      const taskState = e.status?.state;
      if (taskState) state = mapTaskState(taskState);
      const text = extractText(e.status?.message?.parts ?? []);
      if (text) finalText = text;
      continue;
    }

    // artifact-update — pending approvals are published this way
    if (e.kind === "artifact-update") {
      const artifactName = e.artifact?.name ?? e.artifact?.artifactId;
      if (artifactName === "pending-approvals") {
        pendingToolCalls = extractPendingToolCalls(e.artifact?.parts ?? []);
      }
      continue;
    }
  }

  logger.info(
    `[roibot-a2a-client] consumed stream — state=${state}, taskId=${taskId ?? "?"}`,
  );

  return { state, finalText, taskId, contextId, pendingToolCalls };
}

function mapTaskState(s: string): DelegateResult["state"] {
  if (s === "completed") return "completed";
  if (s === "input-required") return "input-required";
  return "failed";
}

function extractText(parts: unknown[]): string {
  return parts
    .filter(
      (p): p is { kind: "text"; text: string } =>
        !!p &&
        typeof p === "object" &&
        (p as { kind?: unknown }).kind === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function extractPendingToolCalls(parts: unknown[]): PendingToolCall[] | undefined {
  for (const p of parts) {
    if (
      p &&
      typeof p === "object" &&
      (p as { kind?: unknown }).kind === "data"
    ) {
      const data = (p as { data?: unknown }).data;
      if (data && typeof data === "object") {
        const calls = (data as { pendingToolCalls?: unknown }).pendingToolCalls;
        if (Array.isArray(calls)) return calls as PendingToolCall[];
      }
    }
  }
  return undefined;
}
