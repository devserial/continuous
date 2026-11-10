import { describe, expect, it } from "vitest";

import {
  anthropicResponseToChatCompletion,
  geminiResponseToChatCompletion,
  openAiStyleResponseToChatCompletion,
} from "./vertexNonStream.js";

describe("Vertex non-streaming responses", () => {
  it("keeps Anthropic text, tool calls and usage", () => {
    const result = anthropicResponseToChatCompletion(
      {
        id: "msg_1",
        content: [
          { type: "text", text: "Looking. " },
          { type: "text", text: "Done." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "read_file",
            input: { filepath: "a.ts" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4 },
      },
      "claude",
    );
    expect(result.choices[0].message.content).toBe("Looking. Done.");
    expect(result.choices[0].message.tool_calls?.[0]).toMatchObject({
      id: "toolu_1",
      function: { name: "read_file", arguments: '{"filepath":"a.ts"}' },
    });
    expect(result.choices[0].finish_reason).toBe("tool_calls");
    expect(result.usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    });
  });

  it("keeps Gemini text, function calls and usage", () => {
    const result = geminiResponseToChatCompletion(
      {
        candidates: [
          {
            content: {
              parts: [
                { text: "Calling. " },
                { functionCall: { name: "ls", args: { dir: "." } } },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 3,
          totalTokenCount: 11,
        },
      },
      "gemini",
    );
    expect(result.choices[0].message.content).toBe("Calling. ");
    const call = result.choices[0].message.tool_calls?.[0];
    expect(call && "function" in call ? call.function : undefined).toEqual({
      name: "ls",
      arguments: '{"dir":"."}',
    });
    expect(result.usage?.total_tokens).toBe(11);
  });

  it("keeps Mistral tool calls", () => {
    const result = openAiStyleResponseToChatCompletion(
      {
        id: "cmpl",
        model: "mistral",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "ls", arguments: "{}" },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
      "mistral",
    );
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.usage?.total_tokens).toBe(3);
  });
});
