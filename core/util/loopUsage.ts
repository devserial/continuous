import type { LoopState } from "..";
import { loopTokensUsed } from "./loopMode";

/**
 * What a loop has used against its budget, and what is left, for the loop's
 * controls (plans/loop-budgets.md). Pure: the clock and the session's token
 * total are passed in. A limit of 0 means none, so there is nothing left to
 * count down and `left` is undefined.
 */
export interface LoopLimitUsage {
  used: number;
  /** 0: no limit */
  max: number;
  /** Undefined without a limit; never below 0 */
  left: number | undefined;
  /** Share used, 0 to 1, undefined without a limit */
  fraction: number | undefined;
}

export interface LoopUsage {
  rounds: LoopLimitUsage;
  tokens: LoopLimitUsage;
  /** Milliseconds since the loop started */
  time: LoopLimitUsage;
  items: { done: number; total: number };
  /** Item runs started, counting each re-run of an item */
  runs: number;
  /** Per item: its runs, where it stands and what its runs used (when recorded) */
  perItem: Array<{
    id: string;
    runs: number;
    status: string;
    tokens?: number;
    ms?: number;
  }>;
}

function limit(used: number, max: number): LoopLimitUsage {
  const bounded = max > 0;
  return {
    used,
    max,
    left: bounded ? Math.max(0, max - used) : undefined,
    fraction: bounded ? Math.min(1, used / max) : undefined,
  };
}

export function loopUsage(
  loop: LoopState,
  ctx: { sessionTokens: number; now: Date },
): LoopUsage {
  const skipped = loop.items.filter((i) => i.skipped).length;
  const done = loop.items.filter((i) => i.status === "done").length - skipped;
  const elapsed = Math.max(
    0,
    ctx.now.getTime() - new Date(loop.startedAt).getTime(),
  );
  return {
    rounds: limit(loop.round, loop.budget.maxRounds),
    tokens: limit(
      loopTokensUsed(loop, ctx.sessionTokens),
      loop.budget.maxTokens,
    ),
    time: limit(elapsed, loop.budget.maxWallMs),
    items: { done: Math.max(0, done), total: loop.items.length },
    runs: loop.items.reduce((n, i) => n + i.attempts, 0),
    perItem: loop.items.map((i) => ({
      id: i.id,
      runs: i.attempts,
      status: i.status,
      ...(i.usage ? { tokens: i.usage.tokens, ms: i.usage.ms } : {}),
    })),
  };
}

/** 1,234 as "1.2K", 8,800,000 as "8.8M". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    return `${trim(n / 1_000_000)}M`;
  }
  if (n >= 1_000) {
    return `${trim(n / 1_000)}K`;
  }
  return String(Math.round(n));
}

function trim(value: number): string {
  return (
    value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  ).toString();
}

/** 5,400,000 ms as "1h 30m"; under a minute as "under 1m". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under 1m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** "8.8M left of 10M", or "1.2M used" when there is no limit. */
export function describeTokenUsage(u: LoopLimitUsage): string {
  return u.left === undefined
    ? `${formatTokenCount(u.used)} used`
    : `${formatTokenCount(u.left)} left of ${formatTokenCount(u.max)}`;
}

/** "1h 41m left of 2h", or "19m in" when there is no limit. */
export function describeTimeUsage(u: LoopLimitUsage): string {
  return u.left === undefined
    ? `${formatDuration(u.used)} in`
    : `${formatDuration(u.left)} left of ${formatDuration(u.max)}`;
}

/** "Round 1 of 3", or "Round 2" when re-planning has no limit. */
export function describeRoundUsage(u: LoopLimitUsage): string {
  return u.max > 0 ? `Round ${u.used} of ${u.max}` : `Round ${u.used}`;
}
