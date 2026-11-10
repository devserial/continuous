import { describe, expect, it } from "vitest";

import { GeminiApi } from "./Gemini.js";

describe("GeminiApi", () => {
  const api = new GeminiApi({
    provider: "gemini",
    apiKey: "test-key",
  });

  describe("_convertBody merges consecutive same-role messages", () => {
    it("merges consecutive tool responses into a single user turn", () => {
      const result = api._convertBody(
        {
          model: "gemini-2.5-flash",
          messages: [
            { role: "user", content: "Use the tools" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "tool_a", arguments: "{}" },
                },
                {
                  id: "call_2",
                  type: "function" as const,
                  function: { name: "tool_b", arguments: "{}" },
                },
              ],
            },
            {
              role: "tool" as const,
              content: "result_a",
              tool_call_id: "call_1",
            },
            {
              role: "tool" as const,
              content: "result_b",
              tool_call_id: "call_2",
            },
          ],
        },
        false,
        true,
      );

      // Should be: user, model(functionCalls), user(functionResponses merged)
      expect(result.contents).toHaveLength(3);
      expect(result.contents[0].role).toBe("user");
      expect(result.contents[1].role).toBe("model");
      expect(result.contents[2].role).toBe("user");
      // Both function responses merged into one user turn
      expect(result.contents[2].parts).toHaveLength(2);
      expect(result.contents[2].parts[0]).toHaveProperty("functionResponse");
      expect(result.contents[2].parts[1]).toHaveProperty("functionResponse");
    });

    it("merges tool responses with following user message", () => {
      const result = api._convertBody(
        {
          model: "gemini-2.5-flash",
          messages: [
            { role: "user", content: "Use the tool" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "tool_a", arguments: "{}" },
                },
              ],
            },
            {
              role: "tool" as const,
              content: "result_a",
              tool_call_id: "call_1",
            },
            { role: "user", content: "Now do something else" },
          ],
        },
        false,
        true,
      );

      // tool response (user) + user message should merge
      expect(result.contents).toHaveLength(3);
      expect(result.contents[2].role).toBe("user");
      expect(result.contents[2].parts).toHaveLength(2);
    });

    it("merges consecutive model messages", () => {
      const result = api._convertBody(
        {
          model: "gemini-2.5-flash",
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "First response" },
            { role: "assistant", content: "Second response" },
          ],
        },
        false,
        true,
      );

      // Two assistant messages should merge into one model message
      expect(result.contents).toHaveLength(2);
      expect(result.contents[1].role).toBe("model");
      expect(result.contents[1].parts).toHaveLength(2);
    });

    it("preserves already-alternating messages unchanged", () => {
      const result = api._convertBody(
        {
          model: "gemini-2.5-flash",
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there" },
            { role: "user", content: "How are you?" },
          ],
        },
        false,
        true,
      );

      expect(result.contents).toHaveLength(3);
      expect(result.contents[0].role).toBe("user");
      expect(result.contents[1].role).toBe("model");
      expect(result.contents[2].role).toBe("user");
    });

    it("keeps assistant text that was sent with a tool call", () => {
      const result = api._convertBody(
        {
          model: "gemini-2.5-flash",
          messages: [
            { role: "user", content: "Use the tool" },
            {
              role: "assistant",
              content: "I will look it up.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "tool_a", arguments: "{}" },
                },
              ],
            },
          ],
        },
        false,
        true,
      );
      expect(result.contents[1].parts[0]).toEqual({
        text: "I will look it up.",
      });
      expect(result.contents[1].parts[1]).toHaveProperty("functionCall");
    });

    it("keeps an image from a tool result", () => {
      const result = api._convertBody(
        {
          model: "gemini-2.5-flash",
          messages: [
            { role: "user", content: "Look" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "shot", arguments: "{}" },
                },
              ],
            },
            {
              role: "tool" as const,
              tool_call_id: "call_1",
              content: [
                { type: "text", text: "see" },
                {
                  type: "image_url",
                  image_url: { url: "data:image/png;base64,aGVsbG8=" },
                },
              ] as any,
            },
          ],
        },
        false,
        true,
      );
      const parts = result.contents[2].parts;
      expect(parts[0].functionResponse.response.content).toBe("see");
      expect(parts[1]).toMatchObject({
        inlineData: { data: "aGVsbG8=" },
      });
    });

    it("joins every system and developer message into the system instruction", () => {
      const result = api._convertBody(
        {
          model: "gemini-2.5-flash",
          messages: [
            { role: "system", content: "Be brief." },
            {
              role: "system",
              content: [{ type: "text", text: "Use tests." }],
            },
            { role: "developer", content: "Prefer small diffs." },
            { role: "user", content: "Hi" },
          ],
        },
        false,
        true,
      );
      expect(result.systemInstruction.parts[0].text).toBe(
        "Be brief.\n\nUse tests.\n\nPrefer small diffs.",
      );
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].role).toBe("user");
    });
  });
});
