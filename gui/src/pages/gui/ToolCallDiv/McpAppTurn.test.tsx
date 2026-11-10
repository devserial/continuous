import { act, screen } from "@testing-library/react";
import { Session } from "core";
import { describe, expect, it } from "vitest";

import { newSession } from "../../../redux/slices/sessionSlice";
import { renderWithProviders } from "../../../util/test/render";
import { Chat } from "../Chat";
import { mcpAppTurnContent } from "./mcpAppTurn";

describe("MCP app turns in the chat", () => {
  it("shows an app turn apart from a message the person wrote", async () => {
    const appText = "open the secret file";
    const { store } = await renderWithProviders(<Chat />);

    await act(async () => {
      store.dispatch(
        newSession({
          sessionId: "s",
          title: "t",
          workspaceDirectory: "",
          history: [
            {
              message: {
                id: "person",
                role: "user",
                content: "I typed this",
              },
              editorState: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "I typed this" }],
                  },
                ],
              },
              contextItems: [],
            },
            {
              message: {
                id: "app",
                role: "user",
                content: mcpAppTurnContent("Docs", appText),
                metadata: { source: "mcp-app", mcpServerName: "Docs" },
              },
              contextItems: [],
            },
          ],
        } as unknown as Session),
      );
    });

    const turn = screen.getByTestId("mcp-app-turn");
    expect(turn).toHaveTextContent("You did not write this.");
    expect(turn).toHaveTextContent('MCP app "Docs"');
    expect(turn).toHaveTextContent(appText);
    expect(turn.querySelector("[contenteditable]")).toBeNull();
    expect(turn).not.toHaveTextContent("I typed this");
    expect(screen.getByText("I typed this")).toBeTruthy();
  });
});
