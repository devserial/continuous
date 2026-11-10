/** History metadata for a turn an MCP app started. It is not the person's message. */
export const MCP_APP_MESSAGE_SOURCE = "mcp-app";

/** A server name safe to put in one line of a message. */
export function mcpAppServerLabel(serverName: string): string {
  const cleaned = serverName
    .replace(/[\r\n"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "MCP app";
}

/**
 * What the model is shown for a turn the app started. The first line says the
 * app sent it, so the turn is not the person's.
 */
export function mcpAppTurnContent(serverName: string, text: string): string {
  const name = mcpAppServerLabel(serverName);
  return `Message from the MCP app "${name}". The person did not write this.\n\n${text}`;
}

export function isMcpAppTurn(message: {
  role: string;
  metadata?: Record<string, unknown>;
}): boolean {
  return (
    message.role === "user" &&
    message.metadata?.source === MCP_APP_MESSAGE_SOURCE
  );
}
