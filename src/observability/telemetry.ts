/**
 * Console-based logger for the MCP server.
 * Provides structured, human-readable log output with timestamps and level icons.
 */

function createConsoleLogger() {
  const formatMessage = (
    level: string,
    message: string,
    attributes: Record<string, unknown> = {}
  ) => {
    const timestamp = new Date().toISOString().slice(11, 23);
    const levelIcon =
      {
        DEBUG: "\u{1F41B}",
        INFO: "\u2139\uFE0F ",
        WARN: "\u26A0\uFE0F ",
        ERROR: "\u274C",
      }[level] || "\u{1F4DD}";

    // Filter out repetitive base attributes for cleaner output
    const baseAttributesToFilter = ["service", "version", "environment", "operation"];
    const filteredAttributes = Object.fromEntries(
      Object.entries(attributes).filter(([key]) => !baseAttributesToFilter.includes(key))
    );

    const attrs =
      Object.keys(filteredAttributes).length > 0 ? ` ${JSON.stringify(filteredAttributes)}` : "";

    return `${timestamp} ${levelIcon} ${message}${attrs}`;
  };

  return {
    info: (message: string, attributes: Record<string, unknown> = {}) =>
      console.log(formatMessage("INFO", message, attributes)),
    error: (message: string, attributes: Record<string, unknown> = {}) =>
      console.error(formatMessage("ERROR", message, attributes)),
    warn: (message: string, attributes: Record<string, unknown> = {}) =>
      console.warn(formatMessage("WARN", message, attributes)),
    debug: (message: string, attributes: Record<string, unknown> = {}) =>
      console.log(formatMessage("DEBUG", message, attributes)),
  };
}

export const customLogger = createConsoleLogger();

export { customLogger as logger };
