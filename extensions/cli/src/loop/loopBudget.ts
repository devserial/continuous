import type { Usage } from "core/index.js";
import { loopBudgetStop, stopLoop } from "core/util/loopMode.js";

import { getSessionLoop } from "../session.js";

import { commitLoop, sessionTokens } from "./loopSession.js";

function counted(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

/**
 * Usage added between two session totals. Cached tokens stay in the
 * details, so the budget can subtract them the same way as an inline run.
 */
export function usageSince(baseline: Usage, current: Usage): Usage {
  const cached = Math.max(
    0,
    counted(current.promptTokensDetails?.cachedTokens) -
      counted(baseline.promptTokensDetails?.cachedTokens),
  );
  const written = Math.max(
    0,
    counted(current.promptTokensDetails?.cacheWriteTokens) -
      counted(baseline.promptTokensDetails?.cacheWriteTokens),
  );
  return {
    promptTokens: Math.max(
      0,
      counted(current.promptTokens) - counted(baseline.promptTokens),
    ),
    completionTokens: Math.max(
      0,
      counted(current.completionTokens) - counted(baseline.completionTokens),
    ),
    ...((cached || written) && {
      promptTokensDetails: {
        ...(cached ? { cachedTokens: cached } : {}),
        ...(written ? { cacheWriteTokens: written } : {}),
      },
    }),
  };
}

/**
 * An item run's request loop: stop the loop when the token or time budget
 * is already spent, so one item cannot keep requesting past it. Between
 * items, decideNext checks the same budget. Returns whether it stopped.
 */
export function stopLoopItemOverBudget(now = new Date()): boolean {
  const loop = getSessionLoop();
  if (!loop || loop.status === "stopped" || loop.current?.kind !== "item") {
    return false;
  }
  const stop = loopBudgetStop(loop, { now, sessionTokens: sessionTokens() });
  if (!stop) return false;
  commitLoop(stopLoop(loop, stop.reason, stop.detail));
  return true;
}
