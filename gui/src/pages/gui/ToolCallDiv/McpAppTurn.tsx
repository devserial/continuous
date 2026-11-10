/**
 * A turn an MCP app started. Shown apart from the person's own messages.
 */
export function McpAppTurn({
  serverName,
  text,
}: {
  serverName: string;
  text: string;
}) {
  return (
    <div
      className="mx-1 my-2 rounded border border-input bg-input px-3 py-2"
      data-testid="mcp-app-turn"
    >
      <div className="text-2xs font-medium text-description">
        MCP app &quot;{serverName}&quot;
      </div>
      <p className="mb-1 text-2xs text-description-muted">
        Sent by the app. You did not write this.
      </p>
      <div className="text-sm whitespace-pre-wrap text-foreground">{text}</div>
    </div>
  );
}
