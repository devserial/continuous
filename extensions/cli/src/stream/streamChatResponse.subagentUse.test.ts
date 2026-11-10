import { ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import type { ChatHistoryItem, ModelUse } from "core/index.js";
import { ACT_TURN_TAIL } from "core/llm/prompts/turns.js";
import { createLoop, startItemRun } from "core/util/loopMode.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../services/index.js";

import { streamChatResponse } from "./streamChatResponse.js";

/*
 * A subagent's run passes its own use (`use: "subagent"`) to the stream, so
 * its requests take the subagent's system message and no tail, whatever the
 * parent turn is doing. Without it the stream reads the session's use: the
 * permission mode's, or a running Loop item's, whose prompt and tail would
 * then reach a subagent that is neither.
 */

const session = vi.hoisted(() => ({
  loop: undefined as unknown,
}));
vi.mock("../session.js", async () => {
  const actual = await vi.importActual<object>("../session.js");
  return {
    ...actual,
    getSessionTaskPlan: () => ({
      items: [{ id: "1", text: "Fix", status: "in_progress" }],
      updatedAt: "2026-11-08T12:00:00.000Z",
    }),
    getSessionLoop: () => session.loop,
    trackSessionUsage: vi.fn(),
  };
});

// No tools and no tool calls, so streamChatResponse makes one request
vi.mock("./handleToolCalls.js", async () => {
  const actual = await vi.importActual<object>("./handleToolCalls.js");
  return {
    ...actual,
    getRequestTools: vi.fn(async () => []),
    handleToolCalls: vi.fn(async () => false),
  };
});

// The service as configured with a tail for Agent and Loop items; the
// reviewer and subagents never get one (core's tailFromRaw)
vi.mock("../services/index.js", () => ({
  services: {
    systemMessage: {
      getSystemMessage: vi.fn(
        async (_mode: string, use?: ModelUse) => `sys for ${use}`,
      ),
      turnTail: vi.fn((use: ModelUse) =>
        use === "agent" || use === "loop" ? ACT_TURN_TAIL : undefined,
      ),
    },
    toolPermissions: {
      getState: vi.fn(() => ({ currentMode: "enabled" })),
      isHeadless: vi.fn(() => false),
    },
    chatHistory: {
      isReady: vi.fn(() => false),
      getHistory: vi.fn(() => []),
    },
  },
}));

vi.mock("../util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const model = {
  model: "us.amazon.nova-2-lite-v1:0",
  defaultCompletionOptions: { contextLength: 100_000, maxTokens: 100 },
} as ModelConfig;

const history: ChatHistoryItem[] = [
  { message: { role: "user", content: "find the callers" }, contextItems: [] },
];

type Sent = Array<{ role: string; content: unknown }>;

/** The newest user message's text; the environment block sits on it too. */
const newest = (sent: Sent) => String(sent.at(-1)?.content);

async function request(options?: { use?: ModelUse }): Promise<Sent> {
  const llmApi = {
    chatCompletionStream: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: "ok" } }] };
      },
    }),
  } as unknown as BaseLlmApi;
  await streamChatResponse(
    history,
    model,
    llmApi,
    new AbortController(),
    undefined,
    false,
    options,
  );
  return vi.mocked(llmApi.chatCompletionStream).mock.calls[0][0]
    .messages as Sent;
}

describe("a request with a use of its own", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.loop = undefined;
  });

  it("carries no tail for use subagent, while the same history with the default use does", async () => {
    const asAgent = await request();
    expect(services.systemMessage.turnTail).toHaveBeenLastCalledWith("agent");
    expect(newest(asAgent).startsWith("find the callers\n\n")).toBe(true);
    expect(newest(asAgent).endsWith(`</context>\n\n${ACT_TURN_TAIL}`)).toBe(
      true,
    );

    const asSubagent = await request({ use: "subagent" });
    expect(services.systemMessage.turnTail).toHaveBeenLastCalledWith(
      "subagent",
    );
    expect(newest(asSubagent).startsWith("find the callers\n\n")).toBe(true);
    expect(newest(asSubagent).endsWith("</context>")).toBe(true);
    expect(newest(asSubagent)).not.toContain(ACT_TURN_TAIL);
  });

  it("asks the service for the subagent's system message, in the current mode", async () => {
    const messages = await request({ use: "subagent" });
    expect(services.systemMessage.getSystemMessage).toHaveBeenCalledWith(
      "enabled",
      "subagent",
    );
    expect(messages[0]).toEqual({
      role: "system",
      content: "sys for subagent",
    });
  });

  it("is not the Loop item's use when a subagent is started from one", async () => {
    const now = new Date();
    const plan = {
      items: [{ id: "1", text: "Fix", status: "in_progress" as const }],
      updatedAt: now.toISOString(),
    };
    session.loop = startItemRun(
      createLoop(plan, { now, sessionTokens: 0 }),
      "1",
      2,
      now,
    );

    const itemRequest = await request();
    expect(services.systemMessage.turnTail).toHaveBeenLastCalledWith("loop");
    expect(newest(itemRequest).endsWith(ACT_TURN_TAIL)).toBe(true);

    const subagentRequest = await request({ use: "subagent" });
    expect(services.systemMessage.turnTail).toHaveBeenLastCalledWith(
      "subagent",
    );
    expect(services.systemMessage.getSystemMessage).toHaveBeenLastCalledWith(
      "enabled",
      "subagent",
    );
    expect(subagentRequest[0]).toEqual({
      role: "system",
      content: "sys for subagent",
    });
    expect(newest(subagentRequest)).not.toContain(ACT_TURN_TAIL);
  });
});
