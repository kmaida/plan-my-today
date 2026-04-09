import { z } from "zod/v3";
import { callROIbotTool, isROIbotConfigured, listROIbotTools } from "../services/roibot-client";
import type { McpServer } from "../types/index";
import { handleToolError } from "../utils/tool-error-utils";

/**
 * Registers tools for delegating work to ROIbot's MCP server.
 *
 * Exposes two tools:
 * - `list-roibot-tools`: Discovers available tools on ROIbot
 * - `delegate-to-roibot`: Calls a specific ROIbot tool with arguments
 *
 * Both tools use Keycard token exchange under the hood: the user's PMT-scoped
 * token is exchanged for a ROIbot-audience token, then PMT connects to ROIbot
 * as an MCP client. This is the multi-agent delegation pattern.
 */
export function registerROIbotDelegateTools(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-roibot-tools",
    {
      title: "List ROIbot Tools",
      description:
        "Discover available tools on the ROIbot (Event ROI) MCP server. " +
        "Call this first to see what ROIbot can do before delegating a task. " +
        "Returns tool names, descriptions, and input schemas.",
      inputSchema: {},
    },
    async (_args, { authInfo }) => {
      if (!authInfo) {
        return {
          content: [
            {
              type: "text",
              text: "❌ No authentication information available. Please ensure you're properly authenticated.",
            },
          ],
        };
      }

      if (!isROIbotConfigured()) {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ ROIbot delegation is not configured. Set ROIBOT_MCP_ENDPOINT in your environment.",
            },
          ],
        };
      }

      try {
        const tools = await listROIbotTools(authInfo);
        const toolList = tools.map((t) => {
          const params = t.inputSchema
            ? Object.keys((t.inputSchema as Record<string, unknown>).properties || {}).join(", ")
            : "none";
          return `• **${t.name}** — ${t.description || "(no description)"}\n  Parameters: ${params}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `🤖 ROIbot has ${tools.length} available tools:\n\n${toolList.join("\n\n")}`,
            },
          ],
        };
      } catch (error) {
        return handleToolError(
          error,
          "roibot",
          [],
          ["Check that ROIbot is running and ROIBOT_MCP_ENDPOINT is correct."]
        );
      }
    }
  );

  mcpServer.registerTool(
    "delegate-to-roibot",
    {
      title: "Delegate Task to ROIbot",
      description:
        "Call a specific tool on the ROIbot (Event ROI) MCP server. " +
        "Use 'list-roibot-tools' first to discover available tools and their parameters. " +
        "Example: delegate-to-roibot with toolName='list_events' to see tracked events.",
      inputSchema: {
        toolName: z
          .string()
          .describe(
            "The name of the ROIbot tool to call (e.g., 'assess_event', 'list_events', 'get_event')"
          ),
        toolArgs: z
          .record(z.unknown())
          .describe("Arguments to pass to the ROIbot tool (must match the tool's input schema)")
          .optional(),
      },
    },
    async ({ toolName, toolArgs }, { authInfo }) => {
      if (!authInfo) {
        return {
          content: [
            {
              type: "text",
              text: "❌ No authentication information available. Please ensure you're properly authenticated.",
            },
          ],
        };
      }

      if (!isROIbotConfigured()) {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ ROIbot delegation is not configured. Set ROIBOT_MCP_ENDPOINT in your environment.",
            },
          ],
        };
      }

      try {
        const result = await callROIbotTool(
          toolName,
          (toolArgs as Record<string, unknown>) || {},
          authInfo
        );
        return { content: result.content };
      } catch (error) {
        return handleToolError(
          error,
          "roibot",
          [],
          [
            `Failed to call ROIbot tool "${toolName}". Check that ROIbot is running and the tool name/arguments are correct.`,
          ]
        );
      }
    }
  );
}
