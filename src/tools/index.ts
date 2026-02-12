import type { McpServer } from "../types/index";
import { registerAssignedActionsTool } from "./assigned-actions";
import { registerCalendarTool } from "./calendar";
import { registerDriveActivityTool } from "./drive-activity";
import { registerGithubTool } from "./github";
import { registerGmailTool } from "./gmail";
import { registerLinearTool } from "./linear";
import { registerListAllTasksTodayTool } from "./list-all-tasks-today/index";
import { registerMarkActionCompleteTool } from "./mark-action-complete";
import { registerMeetingNotesTool } from "./meeting-notes";
import { registerReadDashboardTasksTool } from "./read-dashboard-tasks";
import { registerSetTaskPriorityTool } from "./set-task-priority";
import { registerSlackListTool } from "./slack-list";

/**
 * Tool registry - maps tool names to their registration functions
 */
export const TOOL_REGISTRY = [
  { name: "list-calendar-events", register: registerCalendarTool },
  { name: "list-linear-issues", register: registerLinearTool },
  { name: "list-assigned-actions", register: registerAssignedActionsTool },
  { name: "list-drive-activity", register: registerDriveActivityTool },
  { name: "list-gmail-todos", register: registerGmailTool },
  { name: "mark-action-complete", register: registerMarkActionCompleteTool },
  { name: "list-github-todos", register: registerGithubTool },
  { name: "list-slack-todos", register: registerSlackListTool },
  { name: "list-all-tasks-today", register: registerListAllTasksTodayTool },
  { name: "list-meeting-notes-actions", register: registerMeetingNotesTool },
  { name: "read-dashboard-tasks", register: registerReadDashboardTasksTool },
  { name: "set-task-priority", register: registerSetTaskPriorityTool },
] as const;

/**
 * Get list of all available tool names
 */
export function getAvailableToolNames(): string[] {
  return TOOL_REGISTRY.map((tool) => tool.name);
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
  TOOL_REGISTRY.forEach(({ register }) => {
    register(mcpServer);
  });
}
