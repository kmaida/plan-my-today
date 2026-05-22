/**
 * Unit tests for the pure helpers in roibot-a2a-client. These cover the
 * state-mapping and event-reduction logic in isolation; the network-bound
 * path (buildClient + token exchange) is covered by integration tests.
 */

import type {
  Message,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { consumeStream, extractText, mapTaskState, terminalStateHint } from "../roibot-a2a-client";

type A2AStreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

async function* gen(events: A2AStreamEvent[]): AsyncGenerator<A2AStreamEvent, void, undefined> {
  for (const e of events) yield e;
}

async function* throwingGen(err: Error): AsyncGenerator<A2AStreamEvent, void, undefined> {
  throw err;
  // unreachable — convinces TS this is a valid generator
  // biome-ignore lint/correctness/noUnreachable: needed for generator type inference
  yield {} as A2AStreamEvent;
}

const text = (t: string): Part => ({ kind: "text", text: t });

describe("mapTaskState", () => {
  it.each([
    ["completed", "completed"],
    ["input-required", "input-required"],
    ["failed", "failed"],
    ["canceled", "failed"],
    ["rejected", "failed"],
    ["auth-required", "failed"],
    ["unknown", "failed"],
    ["submitted", "failed"],
    ["working", "failed"],
    ["totally-invalid", "failed"],
  ])("maps %s -> %s", (input, expected) => {
    expect(mapTaskState(input)).toBe(expected);
  });
});

describe("terminalStateHint", () => {
  it("returns hints for canceled / rejected / auth-required", () => {
    expect(terminalStateHint("canceled")).toBe("ROIbot canceled the task");
    expect(terminalStateHint("rejected")).toBe("ROIbot rejected the task");
    expect(terminalStateHint("auth-required")).toBe("ROIbot needs authentication for this task");
  });

  it("returns undefined for states that don't need user-facing distinction", () => {
    expect(terminalStateHint("failed")).toBeUndefined();
    expect(terminalStateHint("completed")).toBeUndefined();
    expect(terminalStateHint("unknown")).toBeUndefined();
    expect(terminalStateHint("nonsense")).toBeUndefined();
  });
});

describe("extractText", () => {
  it("joins text parts with newlines and trims outer whitespace", () => {
    // Only the outer .trim() runs — inner whitespace inside a single part is preserved.
    expect(extractText([text("  hello"), text("world  ")])).toBe("hello\nworld");
  });

  it("filters out non-text parts", () => {
    const parts: Part[] = [
      text("keep me"),
      { kind: "file", file: { name: "x.pdf", mimeType: "application/pdf", uri: "https://e.x/x" } },
      { kind: "data", data: { foo: "bar" } },
    ];
    expect(extractText(parts)).toBe("keep me");
  });

  it("returns empty string for empty input", () => {
    expect(extractText([])).toBe("");
  });
});

describe("consumeStream", () => {
  const taskStatusUpdate = (state: string, parts: Part[] = []): TaskStatusUpdateEvent => ({
    kind: "status-update",
    contextId: "ctx",
    taskId: "task-1",
    final: state === "completed",
    status: {
      state: state as TaskStatusUpdateEvent["status"]["state"],
      message: parts.length
        ? {
            kind: "message",
            messageId: "m-1",
            role: "agent",
            parts,
          }
        : undefined,
    },
  });

  const message = (parts: Part[]): Message => ({
    kind: "message",
    messageId: "m-2",
    role: "agent",
    parts,
  });

  const artifactUpdate = (parts: Part[]): TaskArtifactUpdateEvent => ({
    kind: "artifact-update",
    contextId: "ctx",
    taskId: "task-1",
    artifact: { artifactId: "a-1", parts },
  });

  it("completed terminal task returns state=completed with final text", async () => {
    const result = await consumeStream(
      gen([taskStatusUpdate("completed", [text("done")])]),
      "ctx-1"
    );
    expect(result).toEqual({ state: "completed", finalText: "done" });
  });

  it("input-required terminal task propagates state through", async () => {
    const result = await consumeStream(
      gen([taskStatusUpdate("input-required", [text("need more info")])]),
      "ctx-1"
    );
    expect(result.state).toBe("input-required");
    expect(result.finalText).toBe("need more info");
  });

  it("later event wins on state", async () => {
    const result = await consumeStream(
      gen([
        taskStatusUpdate("working", [text("step 1")]),
        taskStatusUpdate("completed", [text("done")]),
      ]),
      "ctx-1"
    );
    expect(result).toEqual({ state: "completed", finalText: "done" });
  });

  it("empty stream yields a failed result with empty text", async () => {
    const result = await consumeStream(gen([]), "ctx-1");
    expect(result).toEqual({ state: "failed", finalText: "" });
  });

  it("standalone message events without a terminal task are promoted to completed", async () => {
    const result = await consumeStream(gen([message([text("agent reply")])]), "ctx-1");
    expect(result).toEqual({ state: "completed", finalText: "agent reply" });
  });

  it("artifact-update text is extracted as finalText", async () => {
    const result = await consumeStream(
      gen([artifactUpdate([text("long report body")]), taskStatusUpdate("completed")]),
      "ctx-1"
    );
    expect(result.finalText).toBe("long report body");
    expect(result.state).toBe("completed");
  });

  it("canceled terminal task surfaces a hint in finalText", async () => {
    const result = await consumeStream(
      gen([taskStatusUpdate("canceled", [text("user clicked stop")])]),
      "ctx-1"
    );
    expect(result.state).toBe("failed");
    expect(result.finalText).toBe("ROIbot canceled the task: user clicked stop");
  });

  it("auth-required terminal task surfaces a hint even with no agent text", async () => {
    const result = await consumeStream(gen([taskStatusUpdate("auth-required")]), "ctx-1");
    expect(result.state).toBe("failed");
    expect(result.finalText).toBe("ROIbot needs authentication for this task");
  });

  it("TimeoutError aborts cleanly with a friendly message", async () => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    const result = await consumeStream(throwingGen(err), "ctx-1");
    expect(result.state).toBe("failed");
    expect(result.finalText).toMatch(/ROIbot timed out/);
  });

  it("non-timeout stream errors rethrow as ROIbotA2AClientError", async () => {
    const err = new Error("network blew up");
    await expect(consumeStream(throwingGen(err), "ctx-1")).rejects.toMatchObject({
      name: "ROIbotA2AClientError",
      cause: err,
    });
  });
});
