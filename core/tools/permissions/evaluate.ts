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
import { hasUnsafeShellConstruct } from "./command";
import { DecisionSource, decideToolCall, findRuleMatch } from "./decide";
import type { ShellKind } from "../../util/shell";
import { builtinRuleOn } from "./policy";
import { parsePermissions, uriToPath } from "./names";
import { findProtected } from "./protectedCall";
import type { ToolPermissions } from "./rules";

/**
 * Brace expansion, `$IFS`, or a variable where the command name is. The safety
 * floor never sees the command that will actually run, so the text is refused
 * when that floor is on.
 */
function floorMustRefuse(command: string): boolean {
  if (unquotedBraceWithComma(command)) return true;
  if (/\$\{?IFS\b/.test(command)) return true;
  return variableInCommandPosition(command);
}

/** A level must not run a command the floor could not see through. */
function hidesTheCommand(command: string): boolean {
  return floorMustRefuse(command) || hasUnsafeShellConstruct(command);
}

function unquotedBraceWithComma(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let body = "";
  let open = false;
  const flush = () => {
    open = false;
    body = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      flush();
      continue;
    }
    if (c === "\\") {
      i++;
      flush();
      continue;
    }
    if (c === "{") {
      open = true;
      body = "";
      continue;
    }
    if (c === "}" && open) {
      if (body.includes(",")) return true;
      flush();
      continue;
    }
    if (open) body += c;
  }
  return false;
}

/** The first word of a simple command, after assignments, is `$name` or `${name}`. */
function variableInCommandPosition(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let cur = "";
  const segments: string[] = [];
  const flush = () => {
    const t = cur.trim();
    if (t) segments.push(t);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || (c === "&" && next === "&")) {
      flush();
      if (c === "&" || (c === "|" && (next === "|" || next === "&"))) i++;
      continue;
    }
    cur += c;
  }
  flush();
  for (const segment of segments) {
    const words = segment.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    const word = words[i];
    if (word && /^\$[{A-Za-z_]/.test(word)) return true;
  }
  return false;
}

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
  const commandText =
    toolName === "run_terminal_command" &&
    typeof parsedArgs.command === "string"
      ? parsedArgs.command
      : undefined;
  const floorOn = builtinRuleOn(input.approval, "refuse-dangerous-commands");
  // The person switched off the safety check's refusals: such a command asks
  if (
    evaluated === "disabled" &&
    basePolicy !== "disabled" &&
    commandText !== undefined &&
    !floorOn
  ) {
    evaluated = "allowedWithPermission";
  }
  // Obfuscation the floor cannot see through is the same as a refusal: a level
  // must not turn it into a run.
  if (
    commandText !== undefined &&
    floorOn &&
    basePolicy !== "disabled" &&
    evaluated !== "disabled" &&
    floorMustRefuse(commandText)
  ) {
    evaluated = "disabled";
  }

  const resolved = processedArgs?.resolvedPath as
    ResolvedPath | null | undefined;
  const resolvedPath = resolved ? uriToPath(resolved.uri) : undefined;

  // Credentials and files that change what runs later always ask, with or
  // without rules, so this runs for every user and not only those with rules.
  // It only ever tightens: a call that is already refused stays refused.
  const protectedHit = findProtected({
    toolName,
    parsedArgs,
    resolvedPath,
    skip: skippedProtections(input.approval),
  });

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
  // A hidden command is not loosened at any level, YOLO included. Otherwise
  // YOLO reaches past a refusal, a rule and a protected path, and Permissive
  // acts only on a call that would otherwise ask.
  const hidden =
    commandText !== undefined && floorOn && hidesTheCommand(commandText);
  const loosening = hidden
    ? undefined
    : found?.level === "yolo" || evaluated === "allowedWithPermission"
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
