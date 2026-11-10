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
});

describe("ToolCallCollector", () => {
  it("joins argument deltas and parses them", () => {
    const c = new ToolCallCollector();
    c.add({ id: "a", function: { name: "read_file", arguments: '{"pa' } });
    c.add({ function: { arguments: 'th":"x.ts"}' } });
    c.add({ id: "b", function: { name: "ls", arguments: "" } });
    expect(c.finish()).toEqual([
      { id: "a", name: "read_file", input: { path: "x.ts" } },
      { id: "b", name: "ls", input: {} },
    ]);
  });

  it("merges interleaved parallel calls by index", () => {
    const c = new ToolCallCollector();
    c.add({
      id: "a",
      index: 0,
      function: { name: "read_file", arguments: "" },
    });
    c.add({ id: "b", index: 1, function: { name: "ls", arguments: "" } });
    c.add({ index: 0, function: { arguments: '{"path":"a.ts"}' } });
    c.add({ index: 1, function: { arguments: '{"path":"."}' } });
    expect(c.finish()).toEqual([
      { id: "a", name: "read_file", input: { path: "a.ts" } },
      { id: "b", name: "ls", input: { path: "." } },
    ]);
  });

  it("gives up on unparseable arguments with an empty object", () => {
    const c = new ToolCallCollector();
    c.add({ id: "a", function: { name: "x", arguments: "{oops" } });
    expect(c.finish()).toEqual([{ id: "a", name: "x", input: {} }]);
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
