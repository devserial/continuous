import type { ToolPolicy } from "@continuedev/terminal-security";
import type { Tool } from "../..";
import type { ResolvedPath } from "../../util/pathResolver";
import {
  approvalLoosening,
  ApprovalSettings,
  isManualCall,
  levelOfCall,
  skippedProtections,
} from "./approval";
import { DecisionSource, decideToolCall, findRuleMatch } from "./decide";
import type { ShellKind } from "../../util/shell";
import { isPrivateFetchTarget } from "../../util/networkAddress";
import { builtinRuleOn } from "./policy";
import { parsePermissions, uriToPath } from "./names";
import { findProtected } from "./protectedCall";
import type { ProtectedHit } from "./protected";
import type { ToolPermissions } from "./rules";

export interface ToolPolicyResult {
  policy: ToolPolicy;
  displayValue?: string;
  /** Present only when the user has rules, so existing callers see no change. */
  source?: DecisionSource;
  /** A sentence a person can read, for the prompt or the refusal. */
  reason?: string;
  /** A command the parser vouched as only reading: why it is Context use */
  readOnly?: string;
  /** The rule that decided, as written in config.yaml. */
  rule?: string;
}

export interface EvaluateInput {
  tool:
    | Pick<
        Tool,
        | "group"
        | "originalFunctionName"
        | "uri"
        | "evaluateToolCallPolicy"
        | "readonly"
      >
    | undefined;
  toolName: string;
  basePolicy: ToolPolicy;
  parsedArgs: Record<string, unknown>;
  processedArgs?: Record<string, unknown>;
  permissions: ToolPermissions | undefined;
  /** The folder a command runs in; lets git be vouched read-only */
  cwd?: string;
  /** The shell that runs it (resolveShell); without one no command is vouched read-only */
  shell?: ShellKind;
  /** The level chosen for each area; absent means Cautious everywhere. */
  approval?: ApprovalSettings;
}

/**
 * The policy for one tool call: the tool's own check first (command safety
 * floor, workspace-only reads), then the user's `toolPermissions` rules on top.
 * Without rules this returns exactly what it did before rules existed.
 */
export function evaluateToolPolicyWithRules(
  input: EvaluateInput,
): ToolPolicyResult {
  const { tool, toolName, basePolicy, parsedArgs, processedArgs } = input;

  // A tool we do not know has nothing to check, as before.
  if (!tool) return { policy: basePolicy };

  // The command, so a refusal can show what was refused. (This used to compare
  // against "runTerminalCommand", which is never the tool's real name, so the
  // command was never shown.)
  let displayValue: string | undefined;
  if (toolName === "run_terminal_command" && parsedArgs.command) {
    displayValue = parsedArgs.command as string;
  }

  let evaluated = tool.evaluateToolCallPolicy
    ? tool.evaluateToolCallPolicy(basePolicy, parsedArgs, processedArgs)
    : basePolicy;
  // The person switched off the safety check's refusals: such a command asks
  if (
    evaluated === "disabled" &&
    basePolicy !== "disabled" &&
    toolName === "run_terminal_command" &&
    !builtinRuleOn(input.approval, "refuse-dangerous-commands")
  ) {
    evaluated = "allowedWithPermission";
  }

  const resolved = processedArgs?.resolvedPath as
    ResolvedPath | null | undefined;
  const resolvedPath = resolved ? uriToPath(resolved.uri) : undefined;

  // Credentials and files that change what runs later always ask, with or
  // without rules, so this runs for every user and not only those with rules.
  // It only ever tightens: a call that is already refused stays refused.
  // A private or local URL always asks. Permissive (Hands-off) and an allow
  // rule can loosen the tool's own "ask", so this is a protection, like a
  // protected path. YOLO still reaches past it.
  const privateUrl =
    toolName === "fetch_url_content" &&
    isPrivateFetchTarget(parsedArgs.url, processedArgs)
      ? ({
          kind: "private-url",
          path: fetchHost(parsedArgs.url),
        } satisfies ProtectedHit)
      : undefined;
  const protectedHit =
    findProtected({
      toolName,
      parsedArgs,
      resolvedPath,
      skip: skippedProtections(input.approval),
    }) ?? privateUrl;

  // The floor: deny rules the person wrote to bind even at YOLO
  const floorRules = parsePermissions({ deny: input.approval?.floor });
  if (floorRules.length) {
    const isMcpCall =
      !!tool.uri?.startsWith("mcp:") && !!tool.originalFunctionName;
    const floorMatch = findRuleMatch({
      toolName,
      mcp: isMcpCall
        ? { serverName: tool.group, toolName: tool.originalFunctionName! }
        : undefined,
      parsedArgs,
      resolvedPath,
      base: basePolicy,
      evaluated,
      rules: floorRules,
    });
    if (floorMatch?.decision === "deny") {
      return {
        policy: "disabled",
        displayValue,
        source: "floor",
        rule: floorMatch.rule.raw,
        reason: `Blocked by your floor rule ${floorMatch.rule.raw}, which binds at every level.`,
      };
    }
  }

  const rules = parsePermissions(input.permissions);
  const call = { parsedArgs, cwd: input.cwd, shell: input.shell };
  const found = levelOfCall(input.approval, toolName, tool, call);
  // YOLO reaches past a refusal, a rule and a protected path; Permissive acts
  // only on a call that would otherwise ask
  const loosening =
    found?.level === "yolo" || evaluated === "allowedWithPermission"
      ? approvalLoosening({
          approval: input.approval,
          tool,
          toolName,
          parsedArgs,
          processedArgs,
          cwd: input.cwd,
          shell: input.shell,
        })
      : undefined;
  const manual =
    isManualCall(input.approval, toolName, tool, call) &&
    basePolicy !== "disabled" &&
    !loosening;
  if (rules.length === 0 && !protectedHit && !loosening && !manual) {
    return {
      policy: evaluated,
      displayValue,
      ...(found?.readOnly ? { readOnly: found.readOnly } : {}),
    };
  }

  const isMcp = !!tool.uri?.startsWith("mcp:") && !!tool.originalFunctionName;

  const decision = decideToolCall({
    toolName,
    mcp: isMcp
      ? { serverName: tool.group, toolName: tool.originalFunctionName! }
      : undefined,
    parsedArgs,
    resolvedPath,
    base: basePolicy,
    evaluated,
    rules,
    protectedHit,
    loosening,
    manual,
  });

  return {
    policy: decision.policy,
    displayValue,
    source: decision.source,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.rule ? { rule: decision.rule } : {}),
    ...(found?.readOnly ? { readOnly: found.readOnly } : {}),
  };
}

function fetchHost(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return raw;
  }
}
