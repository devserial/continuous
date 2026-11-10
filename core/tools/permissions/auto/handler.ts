import type { ToolPolicy } from "@continuedev/terminal-security";
import type { ILLM } from "../../..";
import { levelOfCall, type ApprovalSettings } from "../approval";
import type { ShellKind } from "../../../util/shell";
import { DecisionSource } from "../decide";
import { uriToPath } from "../names";
import { EvaluateInput, evaluateToolPolicyWithRules } from "../evaluate";
import type { ToolPermissions } from "../rules";
import { ReviewCategory } from "./categories";
import { ReviewResult } from "./parse";
import { ReviewEnvironment, ReviewHistory } from "./prompt";
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  reviewToolCall,
  ReviewerReasoning,
  unavailable,
} from "./review";
import { AutoReviewSessions, reviewContextKey } from "./state";

export interface AutoReviewRequest {
  sessionId: string;
  toolName: string;
  basePolicy: ToolPolicy;
  parsedArgs: Record<string, unknown>;
  processedArgs?: Record<string, unknown>;
  history: ReviewHistory;
  /** The level of each area; absent means every call is reviewed. */
  approval?: ApprovalSettings;
  /** No person to ask: an unusable reviewer refuses. */
  headless?: boolean;
}

export interface AutoReviewReply {
  decision: "allow" | "ask" | "deny";
  reason: string;
  category?: ReviewCategory;
  /**
   * Who decided. "rules" means the deterministic engine (a deny, ask or allow
   * rule, a protected path, the safety floor, or an allowed policy) and the
   * reviewer was not asked. "reviewer" is the model. "system" is Auto itself
   * (unavailable, off, or a refusal cap).
   */
  by: "rules" | "reviewer" | "system";
  /** For `by: "rules"`: which rule or check decided. */
  ruleSource?: DecisionSource;
  /** The command or path, for showing a refusal. */
  displayValue?: string;
  cached?: boolean;
  /** The reviewer's reply could not be read, so the call was left for the user. */
  unusable?: boolean;
}

export interface AutoReviewDeps {
  tool: EvaluateInput["tool"];
  permissions: ToolPermissions | undefined;
  /** `experimental.enableAutoApproval`. */
  enabled: boolean;
  /** The model chosen for the reviewer role; never a chat model. */
  reviewer: Pick<ILLM, "chat"> | null | undefined;
  /** The shell commands run in (resolveShell) */
  shell?: ShellKind;
  /** `modeModels.reviewer.reasoningEffort`, as completion options. */
  reviewerReasoning?: ReviewerReasoning;
  environment: ReviewEnvironment;
  sessions: AutoReviewSessions;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A workspace folder as a path: the IDE gives file URIs. */
function folderPath(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  return dir.startsWith("file:") ? uriToPath(dir) : dir;
}

/** Sources where the user or the safety floor already spoke: the reviewer cannot move them. */
const FINAL_SOURCES: DecisionSource[] = [
  "deny-rule",
  "ask-rule",
  "allow-rule",
  "protected-path",
  "safety-floor",
];

/**
 * Decide one call in Auto mode.
 *
 * Order (plans/tool-auto-approval.md section 5): the deterministic engine runs
 * first and anything it settles is returned as is. Only a call it leaves open,
 * that is an "ask" that came from the tool's own setting or default and not
 * from a rule, a protected path or the safety floor, reaches the reviewer. The
 * reviewer can turn that ask into allow or deny, never the other way round.
 */
export async function autoReviewToolCall(
  deps: AutoReviewDeps,
  req: AutoReviewRequest,
): Promise<AutoReviewReply> {
  const evaluated = evaluateToolPolicyWithRules({
    tool: deps.tool,
    toolName: req.toolName,
    basePolicy: req.basePolicy,
    parsedArgs: req.parsedArgs,
    processedArgs: req.processedArgs,
    permissions: deps.permissions,
    approval: req.approval,
    cwd: folderPath(deps.environment.workspaceDirs?.[0]),
    shell: deps.shell,
  });
  const base = { displayValue: evaluated.displayValue };
  const settled = (
    decision: AutoReviewReply["decision"],
    fallback: string,
  ): AutoReviewReply => ({
    ...base,
    decision,
    by: "rules",
    ruleSource: evaluated.source,
    reason: evaluated.reason ?? fallback,
  });

  if (evaluated.policy === "disabled") {
    return settled("deny", "Refused by a rule or the safety check.");
  }
  if (evaluated.policy === "allowedWithoutPermission") {
    return settled("allow", "Allowed without review.");
  }
  if (evaluated.source && FINAL_SOURCES.includes(evaluated.source)) {
    return settled("ask", "Your rules ask before this runs.");
  }

  // Only an area set to Automatic has a reviewer: the others leave an open
  // call to the person
  const found = levelOfCall(req.approval, req.toolName, deps.tool, {
    parsedArgs: req.parsedArgs,
    cwd: folderPath(deps.environment.workspaceDirs?.[0]),
    shell: deps.shell,
  });
  if (found && found.level !== "automatic") {
    return settled("ask", "This area is not set to Automatic.");
  }

  // The call is open. From here Auto is the only thing that may loosen it.
  const system = (result: ReviewResult): AutoReviewReply => ({
    ...base,
    ...result,
    by: "system",
  });
  if (!deps.enabled) {
    return system(unavailable("Auto approval is turned off.", false));
  }
  if (!deps.reviewer) {
    return system(
      unavailable(
        "Choose a reviewer model in Settings > Models.",
        req.headless,
      ),
    );
  }

  const state = deps.sessions.get(req.sessionId);
  const limits = deps.permissions?.auto?.limits;
  const context = reviewContextKey(req.history.userMessages);
  const cached = state.cached(req.toolName, req.parsedArgs, context);
  // A cached answer is not counted again. The cap is for new refusals.
  if (cached) {
    return { ...base, ...cached, by: reviewedBy(cached), cached: true };
  }
  const raw = await reviewToolCall(
    deps.reviewer,
    {
      toolName: req.toolName,
      args: req.parsedArgs,
      history: req.history,
      environment: deps.environment,
      settings: deps.permissions?.auto,
    },
    {
      timeoutMs: deps.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      signal: deps.signal,
      headless: req.headless,
      reasoning: deps.reviewerReasoning,
    },
  );
  state.remember(req.toolName, req.parsedArgs, raw, context);

  const result = state.record(raw, limits);
  return { ...base, ...result, by: reviewedBy(result) };
}

function reviewedBy(result: ReviewResult): "system" | "reviewer" {
  return result.category === "reviewer-unavailable" ||
    result.category === "denial-limit"
    ? "system"
    : "reviewer";
}
