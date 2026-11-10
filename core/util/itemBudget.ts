import type { LoopState, TaskItem } from "..";

/**
 * A to-do's own budget (plans/loop-budgets.md, "Budgets per task"): how much
 * of the loop's turns, tokens and time one item may use. Written in the plan
 * file as `budget: 25 turns, 200K tokens, 20 min, $0.60`.
 *
 * Turns, tokens and minutes are enforced. A dollar amount is parsed and kept
 * but not enforced: the loop has no cost counter yet.
 */
export interface ItemBudget {
  /** Model requests in one run of the item */
  turns?: number;
  /** Output plus input the provider did not cache, over all the item's runs */
  tokens?: number;
  /** Wall time over all the item's runs */
  minutes?: number;
  /** Carried, not enforced */
  usd?: number;
}

export type BudgetKind = "turns" | "tokens" | "minutes";

const SCALE: Record<string, number> = { k: 1_000, m: 1_000_000 };

/**
 * `25 turns, $0.60, 20 min, 200K tokens`: parts in any order, separated by
 * commas. Units: `turn(s)`, `token(s)` or `tok` (with K or M after the
 * number), `min`, `mins`, `minute(s)`, `m`, and `$` for dollars. A kind may
 * be given once; a number must be positive.
 */
export function parseItemBudget(
  text: string,
): { ok: true; budget: ItemBudget } | { ok: false; error: string } {
  const budget: ItemBudget = {};
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, error: "budget: nothing after it" };
  }
  for (const part of parts) {
    const dollars = /^\$\s*(\d+(?:\.\d+)?)$/.exec(part);
    const counted =
      /^(\d+(?:\.\d+)?)\s*([km])?\s*(turns?|tokens?|tok|minutes?|mins?|m)$/i.exec(
        part,
      );
    let kind: keyof ItemBudget;
    let value: number;
    if (dollars) {
      kind = "usd";
      value = Number(dollars[1]);
    } else if (counted) {
      const unit = counted[3].toLowerCase();
      const scale = counted[2] ? SCALE[counted[2].toLowerCase()] : 1;
      value = Number(counted[1]) * scale;
      if (unit.startsWith("turn")) kind = "turns";
      else if (unit.startsWith("tok")) kind = "tokens";
      else kind = "minutes";
      // K and M scale token counts only; `5m` is five minutes
      if (kind !== "tokens" && counted[2]) {
        return {
          ok: false,
          error: `budget: "${part}" is not a number of ${kind}`,
        };
      }
    } else {
      return {
        ok: false,
        error: `budget: "${part}" is not turns, tokens, minutes or a dollar amount (for example "25 turns, 200K tokens, 20 min, $0.60")`,
      };
    }
    if (!(value > 0)) {
      return { ok: false, error: `budget: "${part}" must be more than zero` };
    }
    if (budget[kind] !== undefined) {
      return { ok: false, error: `budget: ${kind} is given twice` };
    }
    budget[kind] = kind === "usd" ? value : Math.round(value);
  }
  return { ok: true, budget };
}

function shortCount(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}K`;
  return String(n);
}

/** The budget as the plan file writes it; parseItemBudget reads it back. */
export function formatItemBudget(budget: ItemBudget): string {
  const parts: string[] = [];
  if (budget.turns !== undefined) parts.push(`${budget.turns} turns`);
  if (budget.tokens !== undefined)
    parts.push(`${shortCount(budget.tokens)} tokens`);
  if (budget.minutes !== undefined) parts.push(`${budget.minutes} min`);
  if (budget.usd !== undefined) parts.push(`$${budget.usd}`);
  return parts.join(", ");
}

/** What an item has used: its turns in the running run, tokens and time over all runs. */
export interface ItemUse {
  turns: number;
  tokens: number;
  ms: number;
}

export interface ItemBudgetBreach {
  which: BudgetKind;
  used: number;
  limit: number;
}

export type ItemBudgetStatus =
  | { state: "ok" }
  | { state: "warn80"; which: BudgetKind; used: number; limit: number }
  | ({ state: "over" } & ItemBudgetBreach);

const WARN_AT = 0.8;

/**
 * Where an item stands against its own budget: ok, over 80% of one limit
 * (the first such), or over a limit (the first such, in the order turns,
 * tokens, minutes). Pure: `use` says what has been used.
 */
export function itemBudgetStatusOf(
  budget: ItemBudget | undefined,
  use: ItemUse,
): ItemBudgetStatus {
  if (!budget) return { state: "ok" };
  const limits: Array<[BudgetKind, number | undefined, number]> = [
    ["turns", budget.turns, use.turns],
    ["tokens", budget.tokens, use.tokens],
    ["minutes", budget.minutes, use.ms / 60_000],
  ];
  let warn: ItemBudgetStatus = { state: "ok" };
  for (const [which, limit, used] of limits) {
    if (limit === undefined) continue;
    if (used >= limit) return { state: "over", which, used, limit };
    if (warn.state === "ok" && used >= limit * WARN_AT) {
      warn = { state: "warn80", which, used, limit };
    }
  }
  return warn;
}

/**
 * What the item has used now: the totals of its earlier runs (`usage`) plus
 * the running run's tokens since it started and its time. `turns` is the
 * running run's request count, which the host counts; it is not kept across
 * runs.
 */
export function itemUseNow(
  loop: LoopState,
  itemId: string,
  ctx: { sessionTokens: number; now: Date; turns: number },
): ItemUse {
  const earlier = loop.items.find((i) => i.id === itemId)?.usage;
  const current = loop.current;
  const running =
    current?.kind === "item" && current.itemId === itemId ? current : undefined;
  return {
    turns: running ? ctx.turns : 0,
    tokens:
      (earlier?.tokens ?? 0) +
      (running?.tokensAtStart !== undefined
        ? Math.max(0, ctx.sessionTokens - running.tokensAtStart)
        : 0),
    ms:
      (earlier?.ms ?? 0) +
      (running
        ? Math.max(0, ctx.now.getTime() - new Date(running.startedAt).getTime())
        : 0),
  };
}

/** An item's status against its budget now (the item carries the budget). */
export function itemBudgetStatus(
  loop: LoopState,
  item: { id: string; budget?: TaskItem["budget"] },
  ctx: { sessionTokens: number; now: Date; turns: number },
): ItemBudgetStatus {
  return itemBudgetStatusOf(item.budget, itemUseNow(loop, item.id, ctx));
}

/** "turns" / "tokens" / "minutes" figures as a person reads them. */
export function describeBreach(b: ItemBudgetBreach): string {
  const used =
    b.which === "minutes" ? Math.round(b.used * 10) / 10 : Math.round(b.used);
  return `used ${used.toLocaleString("en-US")} of its ${b.limit.toLocaleString("en-US")} ${b.which}`;
}

/** The report of a run ended over its item budget. The work is kept. */
export function overBudgetReport(b: ItemBudgetBreach): {
  outcome: "stuck";
  summary: string;
} {
  return {
    outcome: "stuck",
    summary: `Over budget: the item ${describeBreach(b)}. What it did is kept.`,
  };
}
