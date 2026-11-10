import { MCPServerStatus, MCPTool } from "..";
import { BuiltInToolNames } from "./builtIn";

const BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(BuiltInToolNames),
);

/** True when `name` is a built-in tool, such as `read_file`. */
export function isBuiltInToolName(name: string): boolean {
  return BUILT_IN_TOOL_NAMES.has(name);
}

export function getMCPToolName(server: MCPServerStatus, tool: MCPTool) {
  return getToolNameFromMCPServer(server.name, tool.name);
}

/** A server name as used in tool names: lowercase, runs of other characters become one `_`. */
export function mcpServerSlug(serverName: string): string {
  return serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") // Remove leading/trailing underscores
    .replace(/_+/g, "_"); // Replace multiple sequential underscores with single underscore
}

/**
 * The name this server's tool is called by.
 *
 * The server slug only counts as a prefix at a `_` boundary, so a shorter
 * name cannot claim a longer one. The result is never a built-in tool name.
 */
export function getToolNameFromMCPServer(
  serverName: string,
  toolName: string,
): string {
  const serverPrefix = mcpServerSlug(serverName);

  if (
    serverPrefix &&
    toolName.startsWith(`${serverPrefix}_`) &&
    !isBuiltInToolName(toolName)
  ) {
    return toolName;
  }

  const qualified = serverPrefix ? `${serverPrefix}_${toolName}` : toolName;
  if (qualified && !isBuiltInToolName(qualified)) {
    return qualified;
  }

  // The qualified name can still be a built-in. Mark it so it cannot.
  const marked = serverPrefix
    ? `${serverPrefix}_mcp_${toolName}`
    : `mcp_${toolName}`;
  return isBuiltInToolName(marked) ? `mcp_${marked}` : marked;
}
