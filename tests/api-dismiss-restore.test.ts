/**
 * REST endpoint tests for dismiss, restore, and evict.
 *
 * Uses jest.spyOn (not jest.mock) to avoid polluting the module registry
 * for other test files that import the same store modules with real I/O.
 */

import request from "supertest";
import { createApp } from "../src/server";
import * as completionStore from "../src/services/action-completion-store";
import * as taskStoreUtils from "../src/utils/task-store-utils";

describe("Dismiss / Restore / Evict endpoints", () => {
  let app: ReturnType<typeof createApp>;
  let spyStoreComplete: jest.SpyInstance;
  let spyStoreIncomplete: jest.SpyInstance;
  let spyRemoveTask: jest.SpyInstance;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    spyStoreComplete = jest
      .spyOn(completionStore, "markActionComplete")
      .mockResolvedValue(undefined);
    spyStoreIncomplete = jest
      .spyOn(completionStore, "markActionIncomplete")
      .mockResolvedValue(undefined);
    spyRemoveTask = jest
      .spyOn(taskStoreUtils, "removeTaskFromStore")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── POST /api/dismiss-task ──────────────────────────────────────────────────

  describe("POST /api/dismiss-task", () => {
    const ENDPOINT = "/api/dismiss-task";

    // -- Validation --

    it("rejects empty body", async () => {
      const res = await request(app).post(ENDPOINT).send({}).expect(400);
      expect(res.body.error).toMatch(/Missing required fields/);
    });

    it("rejects missing identifier", async () => {
      const res = await request(app)
        .post(ENDPOINT)
        .send({ source: "drive" })
        .expect(400);
      expect(res.body.error).toMatch(/Missing required fields/);
    });

    it("rejects invalid source", async () => {
      const res = await request(app)
        .post(ENDPOINT)
        .send({ source: "linear", identifier: "KIM-1" })
        .expect(400);
      expect(res.body.error).toMatch(/Invalid source/);
    });

    it("rejects Slack saved messages", async () => {
      const res = await request(app)
        .post(ENDPOINT)
        .send({
          source: "slack",
          identifier: "C123:1234.5678",
          slackType: "saved",
        })
        .expect(400);
      expect(res.body.error).toMatch(/emoji/i);
    });

    // -- Happy path --

    it.each(["meeting-note", "slack", "drive", "adhoc"])(
      "accepts valid source: %s",
      async (source) => {
        const body: Record<string, string> = {
          source,
          identifier: "test-id",
        };
        // Slack non-saved needs a slackType to pass the saved-message guard
        if (source === "slack") body.slackType = "mention";

        const res = await request(app).post(ENDPOINT).send(body).expect(200);
        expect(res.body.success).toBe(true);
      },
    );

    it("calls storeComplete with source, identifier, and metadata", async () => {
      await request(app)
        .post(ENDPOINT)
        .send({
          source: "drive",
          identifier: "file123",
          metadata: { driveType: "unresolved-comment" },
        })
        .expect(200);

      expect(spyStoreComplete).toHaveBeenCalledWith("drive", "file123", {
        driveType: "unresolved-comment",
      });
    });

    it("evicts from task store when taskId is provided", async () => {
      await request(app)
        .post(ENDPOINT)
        .send({ source: "drive", identifier: "file123", taskId: "uuid-1" })
        .expect(200);

      expect(spyRemoveTask).toHaveBeenCalledWith("uuid-1");
    });

    it("does not evict from task store when taskId is absent", async () => {
      await request(app)
        .post(ENDPOINT)
        .send({ source: "drive", identifier: "file123" })
        .expect(200);

      expect(spyRemoveTask).not.toHaveBeenCalled();
    });
  });

  // ── POST /api/restore-dismissed-task ────────────────────────────────────────

  describe("POST /api/restore-dismissed-task", () => {
    const ENDPOINT = "/api/restore-dismissed-task";

    it("rejects empty body", async () => {
      const res = await request(app).post(ENDPOINT).send({}).expect(400);
      expect(res.body.error).toMatch(/Missing required fields/);
    });

    it("rejects invalid source", async () => {
      const res = await request(app)
        .post(ENDPOINT)
        .send({ source: "github", identifier: "x" })
        .expect(400);
      expect(res.body.error).toMatch(/Invalid source/);
    });

    it.each(["meeting-note", "slack", "drive", "adhoc"])(
      "restores with valid source: %s",
      async (source) => {
        const res = await request(app)
          .post(ENDPOINT)
          .send({ source, identifier: "test-id" })
          .expect(200);

        expect(res.body.success).toBe(true);
        expect(spyStoreIncomplete).toHaveBeenCalledWith(source, "test-id");
      },
    );
  });

  // ── POST /api/tasks/evict ──────────────────────────────────────────────────

  describe("POST /api/tasks/evict", () => {
    const ENDPOINT = "/api/tasks/evict";

    it("rejects missing taskId", async () => {
      const res = await request(app).post(ENDPOINT).send({}).expect(400);
      expect(res.body.error).toMatch(/Missing required field: taskId/);
    });

    it("evicts task by taskId", async () => {
      const res = await request(app)
        .post(ENDPOINT)
        .send({ taskId: "uuid-42" })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(spyRemoveTask).toHaveBeenCalledWith("uuid-42");
    });
  });
});
