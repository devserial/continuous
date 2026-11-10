import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class LanguageModelTextPart {
    constructor(public value: string) {}
  }
  class LanguageModelToolCallPart {
    constructor(
      public callId: string,
      public name: string,
      public input: object,
    ) {}
  }
  class LanguageModelToolResultPart {
    constructor(
      public callId: string,
      public content: unknown[],
    ) {}
  }
  class LanguageModelDataPart {
    constructor(
      public data: Uint8Array,
      public mimeType: string,
    ) {}
  }
  class McpStdioServerDefinition {
    cwd?: unknown;
    constructor(
      public label: string,
      public command: string,
      public args: string[] = [],
      public env: Record<string, unknown> = {},
      public version?: string,
    ) {}
  }
  class McpHttpServerDefinition {
    constructor(
      public label: string,
      public uri: unknown,
      public headers: Record<string, string> = {},
      public version?: string,
    ) {}
  }
  class EventEmitter {
    listeners: (() => void)[] = [];
    event = (l: () => void) => {
      this.listeners.push(l);
      return { dispose() {} };
    };
    fire() {
      this.listeners.forEach((l) => l());
    }
    dispose() {}
  }
  return {
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelDataPart,
    McpStdioServerDefinition,
    McpHttpServerDefinition,
    EventEmitter,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    Uri: {
      file: (p: string) => ({ scheme: "file", path: p }),
      parse: (u: string) => ({ toString: () => u }),
    },
  };
});

import * as vscode from "vscode";

import {
  ContinuedLanguageModelChatProvider,
  groupToAccount,
  modelInfo,
  toChatMessages,
  ToolCallCollector,
} from "./languageModelChatProvider";
import {
  ContinuedMcpServerDefinitionProvider,
  toDefinition,
} from "./mcpServerDefinitionProvider";

const msg = (role: number, content: unknown[]) =>
  ({ role, content, name: undefined }) as any;

describe("toChatMessages", () => {
  it("keeps text, assistant tool calls and tool results in order", () => {
    const out = toChatMessages([
      msg(1, [new vscode.LanguageModelTextPart("What changed?")]),
      msg(2, [
        new vscode.LanguageModelTextPart("Checking."),
        new vscode.LanguageModelToolCallPart("c1", "view_diff", {
          staged: true,
        }),
      ]),
      msg(1, [
        new vscode.LanguageModelToolResultPart("c1", [
          new vscode.LanguageModelTextPart("diff --git a b"),
        ]),
      ]),
    ]);
    expect(out).toEqual([
      { role: "user", content: "What changed?" },
      {
        role: "assistant",
        content: "Checking.",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "view_diff", arguments: '{"staged":true}' },
          },
        ],
      },
      { role: "tool", toolCallId: "c1", content: "diff --git a b" },
    ]);
  });

  it("places tool results before user text from the same message", () => {
    const out = toChatMessages([
      msg(2, [
        new vscode.LanguageModelToolCallPart("c1", "run_in_terminal", {
          command: "ls",
        }),
      ]),
      msg(1, [
        new vscode.LanguageModelTextPart("also, the user typed this"),
        new vscode.LanguageModelToolResultPart("c1", [
          new vscode.LanguageModelTextPart("file.ts"),
        ]),
      ]),
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(out[1]).toMatchObject({ role: "tool", content: "file.ts" });
    expect(out[2]).toMatchObject({
      role: "user",
      content: "also, the user typed this",
    });
  });

  it("describes binary tool output instead of dumping every byte", () => {
    const out = toChatMessages([
      msg(1, [
        new vscode.LanguageModelToolResultPart("c1", [
          new (vscode as any).LanguageModelDataPart(
            new Uint8Array(50_000),
            "image/png",
          ),
        ]),
      ]),
    ]);
    expect(out).toEqual([
      { role: "tool", toolCallId: "c1", content: "[image/png, 49 KB]" },
    ]);
    expect(
      String(out[0] && "content" in out[0] ? out[0].content : ""),
    ).not.toContain('"0":');
  });
});

describe("ToolCallCollector", () => {
  it("joins argument deltas and parses them", () => {
    const c = new ToolCallCollector();
    c.add({ id: "a", function: { name: "read_file", arguments: '{"pa' } });
    c.add({ function: { arguments: 'th":"x.ts"}' } });
    c.add({ id: "b", function: { name: "ls", arguments: "" } });
    expect(c.finish()).toEqual({
      calls: [
        { id: "a", name: "read_file", input: { path: "x.ts" } },
        { id: "b", name: "ls", input: {} },
      ],
      rejected: [],
    });
  });

  it("rejects tool calls whose arguments do not parse", () => {
    const c = new ToolCallCollector();
    c.add({
      id: "a",
      function: { name: "run_in_terminal", arguments: '{"command":' },
    });
    c.add({ id: "b", function: { name: "ls", arguments: "{}" } });
    expect(c.finish()).toEqual({
      calls: [{ id: "b", name: "ls", input: {} }],
      rejected: ["run_in_terminal"],
    });
  });
});

const llm = (over: Record<string, unknown> = {}) =>
  ({
    title: "Claude Sonnet",
    providerName: "anthropic",
    underlyingProviderName: "anthropic",
    model: "claude-sonnet-4-5",
    contextLength: 200_000,
    completionOptions: { maxTokens: 8_000 },
    capabilities: { tools: true },
    ...over,
  }) as any;

describe("language model provider", () => {
  it("does not run tool calls collected before cancellation", async () => {
    let cancelled = false;
    const model = llm({
      title: "t",
      streamChat: async function* () {
        yield {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "a",
              function: {
                name: "run_in_terminal",
                arguments: '{"command":"ls"}',
              },
            },
          ],
        };
        cancelled = true;
      },
    });
    const provider = new ContinuedLanguageModelChatProvider();
    provider.update([model]);
    const reported: unknown[] = [];
    await provider.provideLanguageModelChatResponse(
      modelInfo(model, "t"),
      [],
      {} as any,
      { report: (part: unknown) => reported.push(part) },
      {
        get isCancellationRequested() {
          return cancelled;
        },
        onCancellationRequested: () => ({ dispose() {} }),
      } as any,
    );
    expect(
      reported.some((part) => part instanceof vscode.LanguageModelToolCallPart),
    ).toBe(false);
  });

  it("fails a turn whose tool call arguments were cut off", async () => {
    const model = llm({
      title: "t",
      streamChat: async function* () {
        yield {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "a",
              function: { name: "run_in_terminal", arguments: '{"command":' },
            },
          ],
        };
      },
    });
    const provider = new ContinuedLanguageModelChatProvider();
    provider.update([model]);
    await expect(
      provider.provideLanguageModelChatResponse(
        modelInfo(model, "t"),
        [],
        {} as any,
        { report: () => {} },
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        } as any,
      ),
    ).rejects.toThrow(/incomplete/);
  });

  it("describes models from the config without keys", () => {
    const info = modelInfo(llm({ apiKey: "sk-secret" }), "Claude Sonnet");
    expect(info).toMatchObject({
      id: "Claude Sonnet",
      name: "Claude Sonnet",
      family: "anthropic",
      version: "claude-sonnet-4-5",
      maxInputTokens: 192_000,
      maxOutputTokens: 8_000,
      capabilities: { toolCalling: true, imageInput: false },
    });
    expect(JSON.stringify(info)).not.toContain("sk-secret");
  });

  it("lists each title once, and nothing when turned off", async () => {
    const p = new ContinuedLanguageModelChatProvider();
    p.update([llm(), llm(), llm({ title: "GPT-5", model: "gpt-5" })]);
    expect(
      (await p.provideLanguageModelChatInformation()).map((m) => m.id),
    ).toEqual(["Claude Sonnet", "GPT-5"]);
    p.setEnabled(false);
    expect(await p.provideLanguageModelChatInformation()).toEqual([]);
  });

  it("adds the catalog models the config does not use, after its own", async () => {
    const p = new ContinuedLanguageModelChatProvider();
    p.update(
      [llm()],
      [
        llm({ title: "Qwen#high", model: "qwen" }),
        llm(), // also in the config: listed once
      ],
    );
    expect(
      (await p.provideLanguageModelChatInformation()).map((m) => m.id),
    ).toEqual(["Claude Sonnet", "Qwen#high"]);
  });

  it("marks models as the user's own (BYOK) and names their routes", () => {
    const info = modelInfo(
      llm({ routeNames: ["bedrock-us", "anthropic-work"] }),
      "Claude Sonnet",
    ) as any;
    expect(info.isBYOK).toBe(true);
    expect(info.tooltip).toContain("routes: bedrock-us, anthropic-work");
  });

  it("lists a Language Models editor group's models when accounts from VS Code are on", async () => {
    const p = new ContinuedLanguageModelChatProvider();
    p.update([
      llm(),
      llm({
        title: "GPT-5 (openai-work)",
        model: "gpt-5",
        routeName: "openai-work",
      }),
    ]);
    const configuration = {
      name: "openai-work",
      provider: "openai",
      apiKey: "sk-x",
    };
    // Off: a group lists nothing
    expect(
      await p.provideLanguageModelChatInformation({ configuration } as any),
    ).toEqual([]);
    const seen: unknown[] = [];
    p.onGroupConfiguration = async (c) => {
      seen.push(c);
      return "openai-work";
    };
    const infos = await p.provideLanguageModelChatInformation({
      configuration,
    } as any);
    expect(infos.map((m) => m.id)).toEqual(["GPT-5 (openai-work)"]);
    expect(seen).toEqual([configuration]);
  });

  it("streams text and reports tool calls at the end", async () => {
    async function* stream() {
      yield { role: "assistant", content: "Let me look. " };
      yield {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", function: { name: "ls", arguments: "{}" } }],
      };
      yield { role: "thinking", content: "hidden" };
    }
    const model = llm({ streamChat: vi.fn(() => stream()) });
    const p = new ContinuedLanguageModelChatProvider();
    p.update([model]);
    const [info] = await p.provideLanguageModelChatInformation();
    const parts: any[] = [];
    await p.provideLanguageModelChatResponse(
      info,
      [msg(1, [new vscode.LanguageModelTextPart("hi")])],
      {
        toolMode: 1,
        tools: [
          { name: "ls", description: "List", inputSchema: { type: "object" } },
        ],
      } as any,
      { report: (x: unknown) => parts.push(x) },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} }),
      } as any,
    );
    expect(
      parts.map((p) => p.value ?? `${p.name}(${JSON.stringify(p.input)})`),
    ).toEqual(["Let me look. ", "ls({})"]);
    const [, , options] = model.streamChat.mock.calls[0];
    expect(options.tools[0].function).toEqual({
      name: "ls",
      description: "List",
      parameters: { type: "object" },
    });
  });
});

describe("MCP provider", () => {
  const stdio = {
    id: "gh",
    name: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "ghp_secret" },
    cwd: "/work",
  } as any;
  const http = {
    id: "docs",
    name: "docs",
    type: "streamable-http",
    url: "https://mcp.example.com/mcp",
    apiKey: "k-secret",
    requestOptions: { headers: { "X-Team": "core" } },
  } as any;

  it("lists definitions without credentials", () => {
    const p = new ContinuedMcpServerDefinitionProvider();
    p.update([
      stdio,
      http,
      { id: "ws", name: "ws", type: "websocket", url: "ws://x" },
    ] as any);
    const defs = p.provideMcpServerDefinitions() as any[];
    expect(defs.map((d) => d.label)).toEqual(["github", "docs"]);
    expect(JSON.stringify(defs)).not.toMatch(/secret|X-Team/);
    expect(defs[0].cwd).toEqual({ scheme: "file", path: "/work" });
  });

  it("adds credentials only when VS Code starts the server", () => {
    const p = new ContinuedMcpServerDefinitionProvider();
    p.update([stdio, http] as any);
    const [s, h] = p.provideMcpServerDefinitions() as any[];
    expect((p.resolveMcpServerDefinition(s) as any).env).toEqual({
      GITHUB_TOKEN: "ghp_secret",
    });
    expect((p.resolveMcpServerDefinition(h) as any).headers).toEqual({
      "X-Team": "core",
      Authorization: "Bearer k-secret",
    });
  });

  it("leaves out disabled servers and changes version when a secret changes", () => {
    const p = new ContinuedMcpServerDefinitionProvider();
    p.update([{ ...stdio, status: "disabled" }] as any);
    expect(p.provideMcpServerDefinitions()).toEqual([]);
    const a = toDefinition(stdio, false) as any;
    const b = toDefinition(
      { ...stdio, env: { GITHUB_TOKEN: "other" } },
      false,
    ) as any;
    expect(a.version).not.toEqual(b.version);
    expect(a.version).not.toContain("ghp_secret");
  });

  it("fires a change only when the servers change", () => {
    const p = new ContinuedMcpServerDefinitionProvider();
    const fired = vi.fn();
    p.onDidChangeMcpServerDefinitions(fired);
    p.update([stdio] as any);
    p.update([{ ...stdio }] as any);
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

describe("groupToAccount", () => {
  it("makes a group an account with its models, key in memory", () => {
    expect(
      groupToAccount({
        name: "Work Bedrock",
        provider: "bedrock",
        region: "us-east-1",
        models: ["us.anthropic.claude-sonnet-4-6", ""],
      }),
    ).toEqual({
      name: "Work-Bedrock",
      account: {
        name: "Work-Bedrock",
        provider: "bedrock",
        env: { region: "us-east-1" },
      },
      models: [
        {
          name: "us.anthropic.claude-sonnet-4-6 (Work-Bedrock)",
          model: "us.anthropic.claude-sonnet-4-6",
          connection: "Work-Bedrock",
        },
      ],
    });
    expect(
      groupToAccount({ provider: "openai", apiKey: "sk" })?.account,
    ).toEqual({
      name: "openai-vscode",
      provider: "openai",
      apiKey: "sk",
    });
    expect(groupToAccount({ name: "x" })).toBeUndefined();
  });
});
