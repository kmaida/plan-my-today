import * as path from "path";
import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod/v3";
import * as fs from "fs/promises";
import { PATHS } from "../constants";
import { filterCompletedTasks } from "../utils/filter-completed-tasks";

const TASKS_CACHE_PATH = path.join(process.cwd(), PATHS.TASKS_CACHE);

/**
 * Valid source keys in the cached latest-tasks.json.
 * These match the top-level keys of ListAllTasksResponse.
 */
const VALID_SOURCES = [
  "calendar",
  "linear",
  "gmail",
  "slack",
  "github",
  "docs",
  "meetingNotes",
  "meetingSummaries",
] as const;

/**
 * Input schema for the read-dashboard-tasks tool
 */
const readDashboardTasksInputSchema = {
  source: z
    .enum(VALID_SOURCES)
    .describe(
      "Optional: return only this source's data. " +
        "One of: calendar, linear, gmail, slack, github, docs, meetingNotes, meetingSummaries. " +
        "Omit to get all sources."
    )
    .optional(),
};

/**
 * Registers the read-dashboard-tasks tool with the MCP server.
 *
 * Reads the locally cached latest-tasks.json (written by list-all-tasks-today)
 * and returns the full, non-compact data. This is a free local file read with
 * no API calls or token exchanges. Use it when the agent needs to look up an
 * item that wasn't in its compact results.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerReadDashboardTasksTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "read-dashboard-tasks",
    {
      title: "Read Dashboard Tasks",
      description:
        "Read the full task data that the dashboard displays. " +
        "This is the same dataset shown in the UI, from the last list-all-tasks-today fetch. " +
        "Free local file read (no API calls, no auth). " +
        "Use this when you need to look up an item the user sees in the dashboard " +
        "but that wasn't in your compact results. " +
        "Optionally filter by source to reduce the response size.",
      inputSchema: readDashboardTasksInputSchema,
    },
    (async (args, _extra) => {
      try {
        const raw = await fs.readFile(TASKS_CACHE_PATH, "utf-8");
        const data = JSON.parse(raw) as Record<string, unknown>;

        // Filter dismissed items so reads are consistent with the UI
        await filterCompletedTasks(data);

        if (args.source) {
          // Return only the requested source + metadata for context
          const filtered = {
            [args.source]: data[args.source],
            metadata: data.metadata,
          };
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(filtered),
              },
            ],
          };
        }

        // Return the full cached data
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data),
            },
          ],
        };
      } catch (error) {
        // File doesn't exist yet, or is unreadable
        const isNotFound =
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT";

        if (isNotFound) {
          return {
            content: [
              {
                type: "text",
                text: "No cached task data yet. Call list-all-tasks-today first to populate the cache.",
              },
            ],
          };
        }

        const message =
          error instanceof Error ? error.message : "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error reading cached tasks: ${message}`,
            },
          ],
        };
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<
      typeof readDashboardTasksInputSchema
    >
  );
}
