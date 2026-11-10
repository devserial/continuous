import { describe, expect, it } from "vitest";

import {
  addCacheControlToContent,
  applyCacheControlToOpenAIBody,
} from "./openaiCacheControl";

const image = {
  type: "image_url" as const,
  image_url: { url: "data:image/png;base64,aaaa" },
};

describe("addCacheControlToContent", () => {
  it("marks an image that ends the message", () => {
    const marked = addCacheControlToContent([
      { type: "text", text: "see this" },
      image,
    ]);
    expect(marked[0].cache_control).toBeUndefined();
    expect(marked[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("marks the last text part when an image is not last", () => {
    const marked = addCacheControlToContent([
      image,
      { type: "text", text: "and this" },
    ]);
    expect(marked[0].cache_control).toBeUndefined();
    expect(marked[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("marks the last of several text parts", () => {
    const marked = addCacheControlToContent([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(marked[0].cache_control).toBeUndefined();
    expect(marked[1].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("applyCacheControlToOpenAIBody", () => {
  it("marks image-ending user messages, not only ones that end in text", () => {
    const body = applyCacheControlToOpenAIBody(
      {
        model: "anthropic/claude-sonnet-4.6",
        messages: [
          { role: "system", content: "You are an agent." },
          { role: "user", content: [{ type: "text", text: "first" }, image] },
          { role: "assistant", content: "ok" },
          { role: "user", content: [{ type: "text", text: "second" }, image] },
        ],
      } as any,
      { system: true, conversation: true },
    );
    const system = body.messages[0].content as any[];
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    const first = body.messages[1].content as any[];
    const second = body.messages[3].content as any[];
    expect(first[1].cache_control).toEqual({ type: "ephemeral" });
    expect(second[1].cache_control).toEqual({ type: "ephemeral" });
    expect(first[0].cache_control).toBeUndefined();
  });
});
