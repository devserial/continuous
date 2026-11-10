import type { ChatHistoryItem } from "../../..";
import type { ReviewHistory } from "./prompt";

/**
 * What the reviewer is shown of a conversation: the user's own messages and
 * the earlier tool calls (name and arguments), never the agent's prose or any
 * tool output.
 */
/** The person's typed text. Attached code and context blocks are left out. */
export function userTextForReview(item: {
  message: ChatHistoryItem["message"];
  editorState?: { content?: unknown };
}): string {
  const typed = typedFromEditor(item.editorState);
  const raw = typed ?? messageText(item.message);
  return raw
    .replace(/<context\b[^>]*>[\s\S]*?<\/context>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function messageText(message: ChatHistoryItem["message"]): string {
  if (message.role !== "user") return "";
  const { content } = message;
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/**
 * Paragraphs of the composer. Code blocks the person attached are a different
 * node, and their contents are not what the person typed.
 */
function typedFromEditor(
  editorState: { content?: unknown } | undefined,
): string | undefined {
  const content = editorState?.content;
  if (!Array.isArray(content)) return undefined;
  const lines: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const node = block as { type?: string; content?: unknown };
    if (node.type !== "paragraph" || !Array.isArray(node.content)) continue;
    const text = node.content
      .map((child) => {
        if (!child || typeof child !== "object") return "";
        const part = child as {
          type?: string;
          text?: string;
          attrs?: { label?: string };
        };
        if (part.type === "text") return part.text ?? "";
        if (part.type === "mention" && typeof part.attrs?.label === "string") {
          return part.attrs.label;
        }
        return "";
      })
      .join("");
    if (text.trim()) lines.push(text.trim());
  }
  return lines.join("\n");
}

export function buildReviewHistory(history: ChatHistoryItem[]): ReviewHistory {
  const userMessages: string[] = [];
  const toolCalls: ReviewHistory["toolCalls"] = [];
  for (const item of history) {
    const { message } = item;
    if (message.role === "user") {
      const text = userTextForReview(item);
      if (text.trim()) userMessages.push(text);
    }
    for (const call of item.toolCallStates ?? []) {
      toolCalls.push({
        name: call.toolCall.function.name,
        args: call.parsedArgs,
      });
    }
  }
  return { userMessages, toolCalls };
}
