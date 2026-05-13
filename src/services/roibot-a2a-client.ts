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
 * Re-exchanging is cheap (Keycard STS keeps its own JWKS cache);
 * always-fresh is correct.
 *
 * **HITL boundary**: every `delegate-task-to-roibot` invocation is
 * gated by a user-approval click in the Todaygent chat UI before this
 * client is even called. Destructive actions inside ROIbot are out of
 * scope for A2A — they must happen in ROIbot's own chat. If ROIbot
 * ever returns `state: 'input-required'` over A2A, the calling tool
 * refuses with a loud error rather than surfacing a mid-task approval.
 */

import { randomUUID } from "node:crypto";
import { type Client, ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { config } from "../config";
import { getLogger } from "../observability/logger";
import { exchangeToken, TokenExchangeError } from "./keycard-client";

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

/**
 * Outcome of an A2A round-trip. `completed` is the happy path; `failed` is
 * a terminal error. `input-required` is theoretically possible per the A2A
 * protocol but disallowed by our policy — destructive actions must happen
 * in ROIbot's own chat, not over A2A — so the calling tool refuses it
 * loudly rather than threading approval state back through.
 */
export interface DelegateResult {
  state: "completed" | "input-required" | "failed";
  /** Final agent text, or empty string if none was produced. */
  finalText: string;
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
        "URL (e.g. https://event-roi.fly.dev/api/agent)."
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
        err
      );
    }
    throw new ROIbotA2AClientError(
      "Unexpected error exchanging token for ROIbot",
      err instanceof Error ? err : undefined
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
  stream: AsyncGenerator<unknown, void, undefined>
): Promise<DelegateResult> {
  let state: DelegateResult["state"] = "failed";
  let finalText = "";

  for await (const event of stream) {
    if (!event || typeof event !== "object") continue;

    const e = event as {
      kind?: string;
      status?: { state?: string; message?: { parts?: unknown[] } };
    };

    // Both `task` and `status-update` carry the same state+text shape; we
    // don't distinguish them here. `artifact-update` events (used by the
    // protocol for pending-approval publication) are ignored — approval is
    // gated UI-side before the call ever leaves the browser.
    if (e.kind === "task" || e.kind === "status-update") {
      const taskState = e.status?.state;
      if (taskState) state = mapTaskState(taskState);
      const text = extractText(e.status?.message?.parts ?? []);
      if (text) finalText = text;
    }
  }

  logger.info(`[roibot-a2a-client] consumed stream — state=${state}`);

  return { state, finalText };
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
        typeof (p as { text?: unknown }).text === "string"
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
}
