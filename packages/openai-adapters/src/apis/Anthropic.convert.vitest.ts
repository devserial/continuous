import { describe, expect, it, vi } from "vitest";

import { AnthropicApi } from "./Anthropic.js";

function api() {
  return new AnthropicApi({
    provider: "anthropic",
    apiKey: "test-key",
    cachingStrategy: "none",
  });
}

describe("Anthropic message conversion", () => {
  it("lifts developer messages into the system prompt", () => {
    const body = api()._convertToCleanAnthropicBody({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "developer", content: "Prefer tests." },
        { role: "user", content: "Hi" },
      ],
    });
    const system = body.system as { text: string }[];
    expect(system.map((part) => part.text)).toEqual([
      "Be brief.",
      "Prefer tests.",
    ]);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("converts an image in a tool result into an image block", () => {
    const body = api()._convertToCleanAnthropicBody({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Look" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "screenshot", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "see attached" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aGVsbG8=" },
            },
          ],
        } as any,
      ],
    });
    const toolResult = (body.messages.at(-1)?.content as any[]).find(
      (part) => part.type === "tool_result",
    );
    expect(toolResult.content).toEqual([
      { type: "text", text: "see attached" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "aGVsbG8=",
        },
      },
    ]);
  });

  it("warns when an image URL is not a data URL", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    api()._convertToCleanAnthropicBody({
      model: "claude-sonnet-4-20250514",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/pic.png" },
            },
          ],
        },
      ],
    });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/not a data URL/);
    warn.mockRestore();
  });
});
