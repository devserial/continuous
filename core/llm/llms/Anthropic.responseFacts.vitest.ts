import { beforeEach, describe, expect, test, vi } from "vitest";

// handleResponse reads events through streamSse. Feed it parsed events
// directly: building a real SSE Response is unreliable across Node versions
// (https://github.com/nodejs/undici/issues/2888) and is not what is under test.
const events = vi.hoisted(() => ({ list: [] as any[] }));
vi.mock("@continuedev/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@continuedev/fetch")>()),
  streamSse: async function* () {
    for (const e of events.list) yield e;
  },
}));

import Anthropic from "./Anthropic.js";

const start = {
  type: "message_start",
  message: {
    id: "msg_123",
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 700,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 500,
      },
    },
  },
};
const delta = (stop: string | null) => ({
  type: "message_delta",
  delta: { stop_reason: stop, stop_sequence: null },
  usage: { output_tokens: 42 },
});

/** A response with the given headers; its body is ignored (streamSse is mocked). */
const response = (headers: Record<string, string> = {}) =>
  new Response("", { status: 200, headers });

async function lastUsage(res: Response) {
  const a = new Anthropic({ apiKey: "k", model: "claude-sonnet-4-6" } as any);
  const out: any[] = [];
  for await (const m of (a as any).handleResponse(res, true)) out.push(m);
  return out.filter((m) => m.usage).pop()?.usage;
}

describe("Anthropic stream response facts", () => {
  beforeEach(() => {
    events.list = [];
  });

  test("passes on the stop reason and the request-id header", async () => {
    events.list = [start, delta("tool_use")];
    const u = await lastUsage(response({ "request-id": "req_abc" }));
    expect(u.promptTokens).toBe(10);
    expect(u.completionTokens).toBe(42);
    expect(u.promptTokensDetails).toMatchObject({
      cachedTokens: 5000,
      cacheWriteTokens: 700,
      cacheWriteTokens5m: 200,
      cacheWriteTokens1h: 500,
    });
    expect(u.response).toEqual({
      stopReason: "tool_use",
      requestId: "req_abc",
    });
  });

  test("falls back to the message ID when a proxy strips the header", async () => {
    events.list = [start, delta("end_turn")];
    const u = await lastUsage(response());
    expect(u.response).toEqual({
      stopReason: "end_turn",
      requestId: "msg_123",
    });
  });

  test("has no stop reason when the stream never says one", async () => {
    events.list = [start, delta(null)];
    const u = await lastUsage(response());
    expect(u.response).toEqual({ requestId: "msg_123" });
  });

  test("a stream cut off before message_stop is an error, not a short reply", async () => {
    events.list = [
      start,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      },
    ];
    await expect(lastUsage(response())).rejects.toThrow(
      /ended before the response was complete/,
    );
  });

  test("stopping the reply mid-block is not reported as a cut-off", async () => {
    events.list = [
      start,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      },
    ];
    const controller = new AbortController();
    controller.abort();
    const a = new Anthropic({ apiKey: "k", model: "claude-sonnet-4-6" } as any);
    const out: any[] = [];
    for await (const m of (a as any).handleResponse(
      response(),
      true,
      controller.signal,
    )) {
      out.push(m);
    }
    expect(out.some((m) => m.content === "Hel")).toBe(true);
  });

  test("never carries a latency: Anthropic does not send one", async () => {
    events.list = [start, delta("end_turn")];
    const u = await lastUsage(response());
    expect(u.response.latencyMs).toBeUndefined();
  });
});

describe("Anthropic non-stream response", () => {
  async function read(body: unknown, headers: Record<string, string> = {}) {
    const a = new Anthropic({ apiKey: "k", model: "claude-sonnet-4-6" } as any);
    const res = new Response(JSON.stringify(body), { status: 200, headers });
    const out: any[] = [];
    for await (const m of (a as any).handleResponse(res, false)) out.push(m);
    return out;
  }

  test("joins every text block and reports usage, not a cost object", async () => {
    const out = await read(
      {
        id: "msg_9",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "there" },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 700,
          cache_creation: {
            ephemeral_5m_input_tokens: 200,
            ephemeral_1h_input_tokens: 500,
          },
        },
      },
      { "request-id": "req_9" },
    );
    expect(out).toEqual([
      {
        role: "assistant",
        content: "Hello there",
        usage: {
          promptTokens: 10,
          completionTokens: 4,
          promptTokensDetails: {
            cachedTokens: 5000,
            cacheWriteTokens: 700,
            cacheWriteTokens5m: 200,
            cacheWriteTokens1h: 500,
          },
          response: { stopReason: "end_turn", requestId: "req_9" },
        },
      },
    ]);
  });

  test("reads text that follows a thinking block, and maps tool_use blocks", async () => {
    const out = await read({
      id: "msg_tool",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "look it up", signature: "sig" },
        { type: "text", text: "Checking." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "get_weather",
          input: { city: "Paris" },
        },
      ],
      usage: { input_tokens: 3, output_tokens: 8 },
    });
    expect(out[0]).toEqual({
      role: "thinking",
      content: "look it up",
      signature: "sig",
    });
    expect(out[1]).toMatchObject({
      role: "assistant",
      content: "Checking.",
      toolCalls: [
        {
          id: "toolu_1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          },
        },
      ],
    });
    expect(out[1].usage.promptTokens).toBe(3);
    expect(out[1].usage.completionTokens).toBe(8);
    expect(out[1].usage.response).toEqual({
      stopReason: "tool_use",
      requestId: "msg_tool",
    });
    expect(out[1].cost).toBeUndefined();
  });
});

describe("Anthropic error bodies", () => {
  async function fail(res: Response) {
    const a = new Anthropic({ apiKey: "k", model: "claude-sonnet-4-6" } as any);
    const out: any[] = [];
    for await (const m of (a as any).handleResponse(res, false)) out.push(m);
    return out;
  }

  test("an HTML proxy page keeps the HTTP status", async () => {
    const html = `<html><body>bad gateway</body></html>`;
    await expect(
      fail(new Response(html, { status: 502, statusText: "Bad Gateway" })),
    ).rejects.toThrow(/Anthropic API sent back 502: <html>/);
  });

  test("a JSON error is still the Anthropic message", async () => {
    await expect(
      fail(
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "overloaded" },
          }),
          { status: 529 },
        ),
      ),
    ).rejects.toThrow(/temporarily overloaded/);
  });
});
