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

/** Hard ceiling on a single A2A round-trip. Tool description promises 1-5 min; this gives generous headroom. */
const A2A_STREAM_TIMEOUT_MS = 5 * 60_000;

/**
 * Start a NEW A2A task. The first message is a free-form text description;
 * ROIbot picks the right tool internally.
 *
 * @remarks
 * Wraps `sendMessageStream` with an `AbortSignal.timeout()` to cap blocking
 * time. Without this, a TCP half-open / proxy timeout / Fly.io sleep would
 * hold the MCP request open indefinitely. The SDK's native `RequestOptions.signal`
 * is the canonical way to cancel — we don't need a manual `Promise.race`.
 */
export async function startTask(authInfo: AuthInfo, task: string): Promise<DelegateResult> {
  const client = await buildClient(authInfo);
  const contextId = randomUUID();
  const stream = client.sendMessageStream(
    {
      message: {
        kind: "message",
        messageId: randomUUID(),
        role: "user",
        contextId,
        parts: [{ kind: "text", text: task }],
      },
    },
    { signal: AbortSignal.timeout(A2A_STREAM_TIMEOUT_MS) }
  );
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
    // Request the full A2A capability set on every exchange. Todaygent's
    // delegation tool is free-form (it doesn't know which ROIbot tool the
    // task will trigger), so we request the max set ROIbot's `/api/agent`
    // declares as `scopes_supported`. Least-privilege narrowing is enforced
    // downstream:
    //   • Cedar policy at the STS caps what *can* be granted regardless of
    //     what's requested (`a2a-todaygent-to-roibot` policy; future @itl
    //     annotations tighten this without code change).
    //   • ROIbot's dashboard tool filter trims the LLM's tool list to what
    //     the bearer's scopes authorize.
    //   • ROIbot's MCP server refuses per-tool calls outside the bearer's
    //     scopes (defense-in-depth).
    // Omitting the third arg sends an RFC 8693 exchange with no `scope`,
    // which the STS interprets as "grant nothing" — issued bearer comes
    // back with scopes: [], dashboard's gate filters to zero tools, and
    // ROIbot fabricates a reply the post-loop guardrail then refuses.
    const response = await exchangeToken(
      authInfo,
      config.roibotAgentEndpoint,
      ["event:read", "event:write", "report:read"],
    );
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
 *
 * Handles four A2A event kinds (per `@a2a-js/sdk`'s `A2AStreamEventData` union):
 *   - `task` / `status-update`: terminal state + optional status message text.
 *     Later events win (the SDK doesn't reliably mark a "final" event for us in
 *     0.3.x stream reductions; trust the last-seen terminal state).
 *   - `message`: standalone agent text (e.g. when ROIbot streams a chunked reply
 *     without wrapping it in a task envelope). We accumulate the latest text.
 *   - `artifact-update`: agent output via the artifact channel (long reports,
 *     ROI assessments, etc.). We extract text parts the same way; non-text parts
 *     (`file`/`data`) are logged and dropped — PMT has no way to render them.
 *
 * If the stream ends without ever seeing a terminal `task`/`status-update` event
 * but we did collect text from `message`/`artifact-update`, treat it as
 * `completed` — empty `failed` would discard a coherent reply.
 *
 * Stream errors (network, JSON-RPC, abort) are caught and wrapped as
 * `ROIbotA2AClientError`. `AbortSignal.timeout` produces a `TimeoutError`
 * `DOMException` — surfaced to the caller as a friendly timeout result rather
 * than a raw SDK error.
 */
async function consumeStream(
  stream: AsyncGenerator<unknown, void, undefined>
): Promise<DelegateResult> {
  let state: DelegateResult["state"] = "failed";
  let finalText = "";
  let sawTerminalTaskEvent = false;

  try {
    for await (const event of stream) {
      if (!event || typeof event !== "object") continue;

      const e = event as {
        kind?: string;
        status?: { state?: string; message?: { parts?: unknown[] } };
        parts?: unknown[];
        artifact?: { parts?: unknown[] };
      };

      if (e.kind === "task" || e.kind === "status-update") {
        sawTerminalTaskEvent = true;
        const taskState = e.status?.state;
        if (taskState) state = mapTaskState(taskState);
        const text = extractText(e.status?.message?.parts ?? []);
        if (text) finalText = text;
      } else if (e.kind === "message") {
        const text = extractText(e.parts ?? []);
        if (text) finalText = text;
      } else if (e.kind === "artifact-update") {
        const parts = e.artifact?.parts ?? [];
        const text = extractText(parts);
        if (text) {
          finalText = text;
        } else if (parts.length > 0) {
          logger.warn("[roibot-a2a-client] artifact-update with non-text parts dropped");
        }
      }
    }
  } catch (err) {
    if (isTimeoutError(err)) {
      logger.warn("[roibot-a2a-client] stream aborted by timeout");
      return { state: "failed", finalText: `ROIbot timed out after ${A2A_STREAM_TIMEOUT_MS / 1000}s.` };
    }
    throw new ROIbotA2AClientError(
      "A2A stream consumption failed",
      err instanceof Error ? err : undefined
    );
  }

  // Stream ended cleanly with text but no terminal task event — agent replied
  // via `message`/`artifact-update` alone. Don't discard it as `failed`.
  if (!sawTerminalTaskEvent && finalText) state = "completed";

  logger.info(`[roibot-a2a-client] consumed stream — state=${state}`);
  return { state, finalText };
}

/** True iff err is a DOMException raised by `AbortSignal.timeout()` or `abort()`. */
function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
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
