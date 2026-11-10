import type { AssistantUnrolled, ModelConfig } from "@continuedev/config-yaml";
import type { ToolPolicy } from "@continuedev/terminal-security";
import type { ChatHistoryItem } from "core/index.js";
import type { ApprovalSettings } from "core/tools/permissions/approval.js";
import {
  autoReviewToolCall,
  type AutoReviewDeps,
  type AutoReviewReply,
} from "core/tools/permissions/auto/handler.js";
import { buildReviewHistory } from "core/tools/permissions/auto/history.js";
import { AutoReviewSessions } from "core/tools/permissions/auto/state.js";
import type { DecisionSource } from "core/tools/permissions/decide.js";
import {
  evaluateToolPolicyWithRules,
  type ToolPolicyResult,
} from "core/tools/permissions/evaluate.js";
import { mcpRuleName } from "core/tools/permissions/names.js";
import type { ToolPermissions as CoreToolPermissions } from "core/tools/permissions/rules.js";
import { resolveShell } from "core/util/shell.js";

import { createLlmApi } from "../config.js";
import { logger } from "../util/logger.js";

import type { PermissionPolicy } from "./types.js";

/**
 * The `toolPermissions` rules of config.yaml and the Auto reviewer, applied in
 * the CLI by the same engine the IDE uses (core/tools/permissions). The CLI has
 * its own tool names and its own `--allow/--ask/--exclude` policies; those run
 * first and keep deciding what they decide. This layer then adds, in this order:
 * deny rules, protected paths, ask rules, allow rules, and (only with
 * `--auto-review`) the reviewer model for what is left. See
 * extensions/cli/src/permissions/README.md.
 */

/** CLI tool name to the name and arguments the core engine understands. */
export interface CoreCall {
  toolName: string;
  parsedArgs: Record<string, unknown>;
  /** Set when the call is an MCP tool, so floor rules on `mcp__server__*` bind. */
  mcp?: { serverName: string; toolName: string };
}

export function toCoreCall(
  name: string,
  args: Record<string, unknown>,
): CoreCall | undefined {
  switch (name) {
    case "Bash":
      return { toolName: "run_terminal_command", parsedArgs: args };
    case "Read":
      return { toolName: "read_file", parsedArgs: args };
    case "Write":
      return { toolName: "create_new_file", parsedArgs: args };
    case "Edit":
      return {
        toolName: "edit_existing_file",
        parsedArgs: { filepath: args.file_path },
      };
    case "MultiEdit":
      return {
        toolName: "multi_edit",
        parsedArgs: { filepath: args.file_path },
      };
    case "List":
      return { toolName: "ls", parsedArgs: { dirPath: args.dirpath } };
    case "Fetch":
      return { toolName: "fetch_url_content", parsedArgs: args };
    case "Search":
      return { toolName: "grep_search", parsedArgs: { query: args.pattern } };
    default: {
      const mcp = mcpCallFromName(name);
      if (!mcp) return undefined;
      return {
        toolName: mcpRuleName(mcp.serverName, mcp.toolName),
        parsedArgs: args,
        mcp,
      };
    }
  }
}

/**
 * An MCP tool the CLI offered under `mcp__<server>__<tool>`, or a tool that
 * already carries its server. Floor rules are written in that form.
 */
export function mcpCallFromName(
  name: string,
): { serverName: string; toolName: string } | undefined {
  const match = /^mcp__([^_].*?)__([^_].+)$/.exec(name);
  if (!match) return undefined;
  return { serverName: match[1], toolName: match[2] };
}

function toToolPolicy(p: PermissionPolicy): ToolPolicy {
  return p === "allow"
    ? "allowedWithoutPermission"
    : p === "ask"
      ? "allowedWithPermission"
      : "disabled";
}

/** `--auto-review`, set once at startup. */
let autoReviewFlag = false;
export function setAutoReviewEnabled(enabled: boolean): void {
  autoReviewFlag = enabled;
}
export function isAutoReviewEnabled(): boolean {
  return autoReviewFlag;
}

const sessions = new AutoReviewSessions();
const SESSION_ID = "cli";

type ChatLike = NonNullable<AutoReviewDeps["reviewer"]>;

/**
 * The reviewer model, wrapped so core's reviewer can call it: the one
 * `modeModels.reviewer` names (any model), else the first with the `reviewer`
 * role. `modeModels.reviewer.reasoningEffort` is not applied here (the reviewer is not
 * a chat model, so it never goes through `withReasoningEffort`); a
 * catalog variant (`Name#variant`) sets the effort there.
 */
export function reviewerModel(
  assistant: AssistantUnrolled | null | undefined,
): ModelConfig | undefined {
  const named = (
    assistant as { modeModels?: { reviewer?: { model?: string } } }
  )?.modeModels?.reviewer?.model;
  const models = (assistant?.models ?? []).filter((m): m is ModelConfig => !!m);
  if (named) {
    const byName = models.find((m) => (m.name ?? m.model) === named);
    if (byName) return byName;
  }
  return models.find((m) => m.roles?.includes("reviewer" as never));
}

export function createReviewer(
  assistant: AssistantUnrolled | null | undefined,
  authConfig: Parameters<typeof createLlmApi>[1],
): ChatLike | null {
  const model = reviewerModel(assistant);
  if (!model) return null;
  const api = createLlmApi(model, authConfig);
  if (!api) return null;
  return {
    chat: async (
      messages: unknown[],
      signal?: AbortSignal,
      options?: { temperature?: number; maxTokens?: number },
    ) => {
      const res = await api.chatCompletionNonStream(
        {
          model: model.model,
          messages: messages as never,
          temperature: options?.temperature ?? 0,
          max_tokens: options?.maxTokens ?? 300,
          stream: false,
        },
        signal ?? new AbortController().signal,
      );
      return {
        role: "assistant",
        content: res.choices?.[0]?.message?.content ?? "",
      };
    },
  } as ChatLike;
}

let cachedReviewer:
  { assistant: unknown; reviewer: ChatLike | null } | undefined;

/** One reviewer per loaded assistant, so a client is not built for every call. */
export function getReviewer(
  assistant: AssistantUnrolled | null | undefined,
  authConfig: Parameters<typeof createLlmApi>[1],
): ChatLike | null {
  if (cachedReviewer && cachedReviewer.assistant === assistant) {
    return cachedReviewer.reviewer;
  }
  const reviewer = createReviewer(assistant, authConfig);
  cachedReviewer = { assistant, reviewer };
  return reviewer;
}

export interface CoreVerdict {
  /** allow runs it; ask needs a person (a refusal when headless); deny refuses. */
  decision: "allow" | "ask" | "deny";
  reason?: string;
  /** Who decided: the rules, the reviewer model, or Auto itself. */
  by: "rules" | "reviewer" | "system";
  /** Which check decided, when the rules did. Headless runs keep deny, floor and protected paths. */
  source?: DecisionSource;
}

export interface CoreRulesInput {
  cliToolName: string;
  args: Record<string, unknown>;
  /** What the CLI's own policies decided for this call. */
  cliPermission: PermissionPolicy;
  /** The CLI tool's own check (command safety floor, and so on). */
  evaluateToolCallPolicy?: (
    base: ToolPolicy,
    args: Record<string, unknown>,
  ) => ToolPolicy;
  assistantPermissions: CoreToolPermissions | undefined;
  reviewer?: ChatLike | null;
  autoReview?: boolean;
  /** The level of each policy area (see policyLevels.ts) */
  approval?: ApprovalSettings;
  /**
   * The MCP server and tool, when the CLI tool is not named `mcp__server__tool`.
   * Floor rules use that form either way.
   */
  mcp?: { serverName: string; toolName: string };
  isHeadless: boolean;
  history?: ChatHistoryItem[];
  cwd?: string;
}

/**
 * Run the core engine for one CLI call. Returns undefined when the layer does
 * not apply (no rules and no reviewer, or a tool core has no name for), so the
 * caller keeps the CLI's own result.
 */
export async function evaluateWithCoreRules(
  input: CoreRulesInput,
): Promise<CoreVerdict | undefined> {
  const {
    cliToolName,
    args,
    cliPermission,
    assistantPermissions: permissions,
    isHeadless,
  } = input;
  const useReviewer = !!input.autoReview;
  if (!permissions && !useReviewer && !input.approval) return undefined;
  const call = toCoreCall(cliToolName, args);
  const mcp = input.mcp ?? call?.mcp;
  if (!call && !mcp) return undefined;

  const tool = mcp
    ? {
        group: mcp.serverName,
        originalFunctionName: mcp.toolName,
        uri: `mcp:${mcp.serverName}`,
        evaluateToolCallPolicy: input.evaluateToolCallPolicy as never,
      }
    : {
        group: "Built-In",
        evaluateToolCallPolicy: input.evaluateToolCallPolicy as never,
      };
  const toolName =
    call?.toolName ?? mcpRuleName(mcp!.serverName, mcp!.toolName);
  const parsedArgs = call?.parsedArgs ?? args;
  const basePolicy = toToolPolicy(cliPermission);

  if (useReviewer) {
    const reply: AutoReviewReply = await autoReviewToolCall(
      {
        tool,
        permissions,
        enabled: true,
        shell: resolveShell().kind,
        reviewer: input.reviewer ?? null,
        environment: {
          workspaceDirs: [input.cwd ?? process.cwd()],
          os: process.platform,
        },
        sessions,
      },
      {
        sessionId: SESSION_ID,
        toolName,
        basePolicy,
        parsedArgs,
        history: buildReviewHistory(input.history ?? []),
        approval: input.approval,
        headless: isHeadless,
      },
    );
    logger.debug("Auto reviewer decision", {
      tool: cliToolName,
      decision: reply.decision,
      by: reply.by,
      category: reply.category,
    });
    return {
      decision: reply.decision,
      reason: reply.reason,
      by: reply.by,
      source: reply.ruleSource,
    };
  }

  const result: ToolPolicyResult = evaluateToolPolicyWithRules({
    tool: tool as never,
    toolName,
    basePolicy,
    parsedArgs,
    permissions,
    approval: input.approval,
    cwd: input.cwd ?? process.cwd(),
    // The shell the CLI runs commands in: its login shell, PowerShell on Windows
    shell: resolveShell().kind,
  });
  return {
    decision:
      result.policy === "disabled"
        ? "deny"
        : result.policy === "allowedWithPermission"
          ? "ask"
          : "allow",
    reason: result.reason,
    by: "rules",
    source: result.source,
  };
}

/**
 * At the default levels, core may only loosen what the CLI already decided,
 * except a refusal, a floor rule or a protected path: those stand in headless
 * runs too, where the CLI's own policy would otherwise allow the call.
 */
export function keepCoreVerdict(
  verdict: CoreVerdict | undefined,
  opts: {
    defaultsOnly: boolean;
    hasPermissions: boolean;
    autoReview: boolean;
  },
): CoreVerdict | undefined {
  if (!verdict) return undefined;
  if (
    verdict.decision === "deny" ||
    verdict.source === "floor" ||
    verdict.source === "protected-path" ||
    verdict.source === "safety-floor"
  ) {
    return verdict;
  }
  if (opts.defaultsOnly && !opts.hasPermissions && !opts.autoReview) {
    return verdict.decision === "allow" ? verdict : undefined;
  }
  return verdict;
}
