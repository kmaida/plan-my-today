import type { McpServer } from "../types/index";
import { getLogger } from "../observability/logger";
import { registerWhoamiTool } from "./whoami";
import { registerCalendarTool } from "./calendar";
import { registerLinearTool } from "./linear";
import { registerAssignedActionsTool } from "./assigned-actions";
import { registerDriveActivityTool } from "./drive-activity";
import { registerGmailTool } from "./gmail";
import { registerGithubTool } from "./github";
import { registerListAllTasksTodayTool } from "./list-all-tasks-today/index";
import { registerSlackConnectTool } from "./slack-connect";
import { registerSlackDisconnectTool } from "./slack-disconnect";
import { registerSlackListTool } from "./slack-list";
import { registerCheckAuthTool } from "./check-auth";

/**
 * Tool registry - maps tool names to their registration functions
 */
export const TOOL_REGISTRY = [
  { name: "whoami", register: registerWhoamiTool },
  { name: "check-auth", register: registerCheckAuthTool },
  { name: "list-calendar-events", register: registerCalendarTool },
  { name: "list-linear-issues", register: registerLinearTool },
  { name: "list-assigned-actions", register: registerAssignedActionsTool },
  { name: "list-drive-activity", register: registerDriveActivityTool },
  { name: "list-gmail-todos", register: registerGmailTool },
  { name: "list-github-todos", register: registerGithubTool },
  { name: "list-slack-todos", register: registerSlackListTool },
  { name: "list-all-tasks-today", register: registerListAllTasksTodayTool },
  { name: "connect-slack", register: registerSlackConnectTool },
  { name: "disconnect-slack", register: registerSlackDisconnectTool },
] as const;

/**
 * Get list of all available tool names
 */
export function getAvailableToolNames(): string[] {
  return TOOL_REGISTRY.map(tool => tool.name);
}

/**
 * Registers all MCP tools with the server
 *
 * This function serves as the central registry for all tools provided
 * by the Todo MCP server. It demonstrates the recommended
 * pattern for organizing tools in a modular MCP server.
 *
 * @param mcpServer - The MCP server instance to register tools with
 */
export function registerAllTools(mcpServer: McpServer): void {
  // Register all tools from the registry
  TOOL_REGISTRY.forEach(({ name, register }) => {
    register(mcpServer);
    // Debug logging to verify each tool is registered
    if (name === "list-github-todos") {
      const logger = getLogger();
      logger.debug("GitHub tool registered successfully", { toolName: name });
    }
  });
}