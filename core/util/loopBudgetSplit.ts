import type { ItemBudget } from "./itemBudget";

/**
 * Ways to divide what is left of a loop's budget among the items still to run
 * (plans/loop-budgets.md, "Dividing the loop's budget"). Pure functions: the
 * caller says what is left and which items remain, and gets a budget per item.
 * Only tokens and minutes are divided; turns are a per-run limit and dollars
 * are not counted yet.
 */
export type SplitStrategy = "none" | "equal" | "weighted" | "fair-share";

export interface SplitTotals {
  /** What is left; undefined or 0: no limit, so nothing to divide */
  tokens?: number;
  minutes?: number;
}

export interface SplitItem {
  id: string;
  /** Relative size for the weighted strategy (default 1) */
  weight?: number;
  /** The item's own budget: it wins over the split, and is capped at what is left */
  budget?: ItemBudget;
}

export interface SplitResult {
  /** Per item, what it may use (explicit budgets kept, split shares filled in) */
  budgets: Record<string, ItemBudget>;
  /** The part held back for extensions, re-plans and a final check */
  reserve: SplitTotals;
}

/** S, M, L as weights: a medium item is twice a small one, a large four times. */
export function sizeWeight(size: string | undefined): number {
  switch (size?.trim().toUpperCase()) {
    case "S":
      return 1;
    case "M":
      return 2;
    case "L":
      return 4;
    default:
      return 1;
  }
}

/**
 * What an item may take of what is left when it starts, under "fair share":
 * a third, or one divided by the items left, whichever is larger, never more
 * than what is left. Unused budget rolls forward because the next item is
 * measured against what then remains.
 */
export function fairShareOf(left: number, itemsLeft: number): number {
  if (left <= 0 || itemsLeft <= 0) return 0;
  return Math.min(left, left * Math.max(1 / 3, 1 / itemsLeft));
}

function shares(
  left: number,
  items: SplitItem[],
  strategy: Exclude<SplitStrategy, "none">,
  weights: number[],
): number[] {
  if (strategy === "equal") return items.map(() => left / items.length);
  if (strategy === "weighted") {
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map((w) => (left * w) / sum);
  }
  // fair-share: each item's floor if every earlier item used its whole share
  const out: number[] = [];
  let remaining = left;
  items.forEach((_, i) => {
    const share = fairShareOf(remaining, items.length - i);
    out.push(share);
    remaining -= share;
  });
  return out;
}

/**
 * Divides `totals`, after holding back `reserve` (a fraction from 0 to 0.9),
 * among `items`. An item with its own budget keeps it, capped at what is
 * left; the others share what the explicit ones did not take.
 */
export function splitBudget(
  totals: SplitTotals,
  items: SplitItem[],
  options: { strategy: SplitStrategy; reserve?: number },
): SplitResult {
  const reserveFraction = Math.min(0.9, Math.max(0, options.reserve ?? 0));
  const reserve: SplitTotals = {};
  const budgets: Record<string, ItemBudget> = {};
  for (const item of items) budgets[item.id] = { ...item.budget };

  for (const kind of ["tokens", "minutes"] as const) {
    const left = totals[kind];
    if (!left || left <= 0) continue;
    const held = left * reserveFraction;
    if (held > 0) reserve[kind] = whole(kind, held);
    let pool = left - held;
    // Explicit budgets come off first, capped at the pool
    for (const item of items) {
      const own = item.budget?.[kind];
      if (own !== undefined) {
        const capped = Math.min(own, pool);
        budgets[item.id][kind] = whole(kind, capped);
        pool -= capped;
      }
    }
    if (options.strategy === "none") continue;
    const open = items.filter((i) => i.budget?.[kind] === undefined);
    if (open.length === 0 || pool <= 0) continue;
    const split = shares(
      pool,
      open,
      options.strategy,
      open.map((i) => Math.max(0, i.weight ?? 1) || 1),
    );
    open.forEach((item, i) => {
      budgets[item.id][kind] = whole(kind, split[i]);
    });
  }
  return { budgets, reserve };
}

/** Tokens round down to a whole number; minutes round down but never to zero. */
function whole(kind: "tokens" | "minutes", n: number): number {
  const down = Math.floor(n);
  return kind === "minutes" ? Math.max(1, down) : down;
}
