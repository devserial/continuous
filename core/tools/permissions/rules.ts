/**
 * Tool permission rules from config.yaml `toolPermissions` (plans/tool-auto-approval.md, B1).
 *
 * Pure functions only: no I/O, no IDE calls. Wiring into `tools/evaluatePolicy`
 * and the GUI is B2. A rule is `toolName(pattern)` or a bare `toolName`.
 */

export type RuleDecision = "allow" | "ask" | "deny";

export interface ParsedRule {
  decision: RuleDecision;
  raw: string;
  toolName: string;
  /** undefined for a bare tool name, which matches any call to that tool */
  pattern?: string;
}

export interface ToolPermissions {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  /** Settings for the experimental reviewer (Auto mode). Never loosens a rule. */
  auto?: {
    environment?: { trustedDomains?: string[]; productionMarkers?: string[] };
    guidance?: { block?: string[]; allow?: string[] };
    limits?: { consecutiveDenials?: number; totalDenials?: number };
  };
}

export interface RuleMatch {
  decision: RuleDecision;
  rule: ParsedRule;
}

/** Parse `toolName(pattern)` or `toolName`. Returns undefined for malformed entries. */
export function parseRule(
  raw: string,
  decision: RuleDecision,
): ParsedRule | undefined {
  const trimmed = raw.trim();
  // Tool names may end in `*` for MCP name patterns (mcp__server__*).
  const m = trimmed.match(/^([A-Za-z_][\w.*-]*)(?:\((.*)\))?$/);
  if (!m) return undefined;
  const [, toolName, pattern] = m;
  if (pattern !== undefined && pattern.trim() === "") return undefined;
  return { decision, raw: trimmed, toolName, pattern };
}

export function parseToolPermissions(perms: ToolPermissions): ParsedRule[] {
  const out: ParsedRule[] = [];
  for (const [decision, list] of [
    ["allow", perms.allow ?? []],
    ["ask", perms.ask ?? []],
    ["deny", perms.deny ?? []],
  ] as const) {
    for (const raw of list) {
      const rule = parseRule(raw, decision);
      if (rule) out.push(rule);
    }
  }
  return out;
}

/**
 * Glob match where `*` matches any run of characters except `/`, and `**`
 * matches across `/`. Pass `ignoreCase` for file paths: Windows and macOS
 * volumes are case-insensitive, so `.ENV` is the same file as `.env` there and
 * a deny rule must not be bypassed by changing the case.
 */
export function globMatch(
  pattern: string,
  value: string,
  ignoreCase = false,
): boolean {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` also matches zero directories, so `**/.env` matches `.env`.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(re + "$", ignoreCase ? "i" : "").test(value);
}

/** MCP tool names are `mcp__<server>__<tool>`; a trailing `*` matches the rest. */
export function mcpNameMatch(pattern: string, toolName: string): boolean {
  return globMatch(pattern, toolName);
}

import { commandCandidateSet } from "./candidates";
import { effectsOfCommand, isEffect } from "./commandSpecs";
import {
  destinationsOf,
  hostInNetSet,
  isNetSet,
  normalizeHost,
  programName,
  type NetSet,
} from "./destinations";
import {
  commandGlobMatch,
  hasUnsafeShellConstruct,
  parseCommand,
} from "./command";

export { hasUnsafeShellConstruct, splitCommandParts } from "./command";

/**
 * A rule written `runTerminalCommand(effect:network)` (or `effect:delete,exec`)
 * matches a command with any of the named effects, whichever program has it
 * (commandSpecs.ts). Only programs with a spec have effects, so this catches
 * what the table knows and says nothing about the rest. An unknown effect
 * name matches nothing.
 */
const EFFECT_PREFIX = "effect:";

/**
 * Destination rules (plans/command-analysis.md, P10), in deny and ask rules:
 *
 *   runTerminalCommand(host:*.aliyuncs.com)       any program reaching a host
 *   runTerminalCommand(curl host:*.aliyuncs.com)  one program
 *   runTerminalCommand(net:metadata)              a named set: metadata, local, private
 *   runTerminalCommand(net:local,private)         several sets
 *
 * The destinations are read from the command (destinations.ts): URL operands
 * and the flags that take a URL, git remotes, ssh, scp, rsync and nc hosts,
 * with IPv4 spellings normalised (`2130706433` is 127.0.0.1) and the globs
 * matched without regard to case. `*` matches any run of characters, so
 * `*.aliyuncs.com` covers the sub-domains and `*aliyuncs.com` the domain too.
 *
 * A destination built from a variable or a substitution is not matched: the
 * reader cannot know it, and that is not a promise it is safe (the command is
 * unsure to the policy engine, and a program with no reader has no
 * destinations here). An allow rule written this way never allows anything.
 */
const DESTINATION_RULE = /^(?:(\S+)\s+)?(host|net):(\S+)$/i;

export function isDestinationPattern(pattern: string): boolean {
  return DESTINATION_RULE.test(pattern.trim());
}

function matchesDestinationRule(
  pattern: string,
  candidates: string[],
): boolean {
  const m = DESTINATION_RULE.exec(pattern.trim());
  if (!m) return false;
  const program = m[1] ? programName(m[1]) : undefined;
  const kind = m[2].toLowerCase();
  const value = m[3];
  const sets: NetSet[] =
    kind === "net"
      ? value
          .split(",")
          .map((n) => n.trim().toLowerCase())
          .filter(isNetSet)
      : [];
  if (kind === "net" && sets.length === 0) return false;
  const wantedHost = kind === "host" ? normalizeHost(value) : "";
  return candidates.some((c) =>
    destinationsOf(c).destinations.some((d) => {
      if (program && d.program !== program) return false;
      if (kind === "net") return sets.some((set) => hostInNetSet(d.host, set));
      // A glob; an IPv4 written in another spelling is compared as dotted
      return (
        globMatch(value, d.host, true) ||
        (!value.includes("*") && d.host === wantedHost)
      );
    }),
  );
}

function matchesEffectRule(pattern: string, candidates: string[]): boolean {
  const wanted = pattern
    .slice(EFFECT_PREFIX.length)
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(isEffect);
  if (wanted.length === 0) return false;
  return candidates.some((c) => {
    const effects = effectsOfCommand(c);
    return wanted.some((w) => effects.has(w));
  });
}

/**
 * Terminal commands are split into parts (quotes respected). A deny rule on
 * any part, or on anything `commandCandidates` finds in the command, refuses
 * it: that is the command as the shell will read it, with quotes removed,
 * directories and `.exe` dropped, case folded, wrappers skipped and nested
 * scripts opened. Ask rules work the same way. An allow rule applies only when
 * the scanner fully understands the command (no substitution, unsafe
 * expansion, file redirect or unterminated quote) and every part is covered by
 * an allow rule, matched exactly as written.
 *
 * Patterns use `*` for any run of characters, including `/`, because a
 * command is not a path (`terraform apply*` must match `terraform apply -var-file=a/b`).
 */
export function matchTerminalCommand(
  rules: ParsedRule[],
  command: string,
): RuleMatch | undefined {
  const toolRules = rules.filter((r) => r.toolName === "runTerminalCommand");
  const parsed = parseCommand(command);
  const { list: candidates, truncated } = commandCandidateSet(command);
  // Deny and ask ignore case: `GIT push` is `git push` on Windows, and a
  // protection must not depend on how a command is capitalised.
  // A command too long to expand in full fails closed: any deny or ask rule
  // matches, because the part that would have matched may have been dropped.
  const hits = (rule: ParsedRule) =>
    rule.pattern === undefined ||
    truncated ||
    (isDestinationPattern(rule.pattern)
      ? matchesDestinationRule(rule.pattern, candidates)
      : rule.pattern.startsWith(EFFECT_PREFIX)
        ? matchesEffectRule(rule.pattern, candidates)
        : candidates.some((c) => commandGlobMatch(rule.pattern!, c, true)));

  for (const rule of toolRules) {
    if (rule.decision === "deny" && hits(rule))
      return { decision: "deny", rule };
  }
  for (const rule of toolRules) {
    if (rule.decision === "ask" && hits(rule)) return { decision: "ask", rule };
  }

  // Allow only what is fully understood.
  if (
    hasUnsafeShellConstruct(command) ||
    parsed.unparsable ||
    parsed.hasFileRedirect ||
    parsed.parts.length === 0
  ) {
    return undefined;
  }
  const allowRules = toolRules.filter((r) => r.decision === "allow");
  if (allowRules.length === 0) return undefined;
  let first: ParsedRule | undefined;
  for (const part of parsed.parts) {
    const hit = allowRules.find(
      (r) => r.pattern === undefined || commandGlobMatch(r.pattern, part),
    );
    if (!hit) return undefined;
    first ??= hit;
  }
  return first ? { decision: "allow", rule: first } : undefined;
}

/** Match a non-terminal tool call by name (and path, for file tools). */
export function matchToolCall(
  rules: ParsedRule[],
  toolName: string,
  target?: string,
): RuleMatch | undefined {
  const named = rules.filter((r) =>
    r.toolName.startsWith("mcp__") && toolName.startsWith("mcp__")
      ? mcpNameMatch(r.toolName, toolName)
      : r.toolName === toolName,
  );
  const matches = (r: ParsedRule) =>
    r.pattern === undefined ||
    (target !== undefined && globMatch(r.pattern, target));

  // Deny wins over ask, ask over allow, regardless of order.
  for (const decision of ["deny", "ask", "allow"] as const) {
    const hit = named.find((r) => r.decision === decision && matches(r));
    if (hit) return { decision, rule: hit };
  }
  return undefined;
}
