import { describe, expect, it } from "vitest";
import {
  formatItemBudget,
  itemBudgetStatus,
  itemBudgetStatusOf,
  overBudgetReport,
  parseItemBudget,
} from "./itemBudget";
import { createLoop, finishItemRun, startItemRun } from "./loopMode";
import {
  buildTaskPlan,
  parseMarkdownChecklist,
  taskItemAttributeLines,
} from "./taskPlan";

const T0 = new Date("2026-11-09T10:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe("parseItemBudget", () => {
  it.each([
    ["25 turns", { turns: 25 }],
    ["200K tokens", { tokens: 200_000 }],
    ["1.5M tokens", { tokens: 1_500_000 }],
    ["20 min", { minutes: 20 }],
    ["20 minutes", { minutes: 20 }],
    ["5m", { minutes: 5 }],
    ["$0.60", { usd: 0.6 }],
    [
      "25 turns, $0.60, 20 min, 200K tokens",
      { turns: 25, usd: 0.6, minutes: 20, tokens: 200_000 },
    ],
  ])("reads %s", (text, budget) => {
    expect(parseItemBudget(text)).toEqual({ ok: true, budget });
  });

  it.each([
    ["", "nothing after it"],
    ["lots", "is not turns"],
    ["0 turns", "more than zero"],
    ["25 turns, 30 turns", "given twice"],
    ["5K min", "is not a number of minutes"],
  ])("refuses %j", (text, why) => {
    const result = parseItemBudget(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(why);
  });

  it("formats what it parses", () => {
    const text = "25 turns, 200K tokens, 20 min, $0.6";
    const parsed = parseItemBudget(text);
    expect(parsed.ok && formatItemBudget(parsed.budget)).toBe(text);
  });
});

describe("itemBudgetStatusOf", () => {
  const budget = { turns: 10, tokens: 100_000, minutes: 10 };
  const use = (turns: number, tokens: number, min: number) => ({
    turns,
    tokens,
    ms: min * 60_000,
  });

  it("is ok under 80%, warns from 80%, is over at the limit", () => {
    expect(itemBudgetStatusOf(budget, use(5, 10_000, 1))).toEqual({
      state: "ok",
    });
    expect(itemBudgetStatusOf(budget, use(8, 10_000, 1))).toEqual({
      state: "warn80",
      which: "turns",
      used: 8,
      limit: 10,
    });
    expect(itemBudgetStatusOf(budget, use(10, 10_000, 1))).toEqual({
      state: "over",
      which: "turns",
      used: 10,
      limit: 10,
    });
  });

  it("names the limit that went over, tokens before minutes, and over beats warn", () => {
    expect(itemBudgetStatusOf(budget, use(9, 150_000, 11))).toMatchObject({
      state: "over",
      which: "tokens",
    });
    expect(itemBudgetStatusOf(budget, use(1, 1, 12))).toMatchObject({
      state: "over",
      which: "minutes",
      used: 12,
    });
  });

  it("has no limit without a budget, and ignores a dollar amount", () => {
    expect(itemBudgetStatusOf(undefined, use(999, 9e9, 999))).toEqual({
      state: "ok",
    });
    expect(itemBudgetStatusOf({ usd: 0.01 }, use(999, 9e9, 999))).toEqual({
      state: "ok",
    });
  });
});

describe("the plan file", () => {
  it("reads a budget line under a to-do and writes it back", () => {
    const items = parseMarkdownChecklist(
      "- [ ] Build it\n  budget: 25 turns, 200K tokens\n  check: npm test\n- [ ] Ship it",
    );
    expect(items[0].budget).toBe("25 turns, 200K tokens");
    const built = buildTaskPlan(items);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.plan.items[0].budget).toEqual({ turns: 25, tokens: 200_000 });
    expect(built.plan.items[1].budget).toBeUndefined();
    expect(
      taskItemAttributeLines(built.plan.items[0], built.plan.items),
    ).toEqual(["  check: npm test", "  budget: 25 turns, 200K tokens"]);
  });

  it("reports an invalid budget against its to-do", () => {
    const built = buildTaskPlan([{ text: "A", budget: "plenty" }]);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toContain("Item 1: budget:");
  });
});

describe("a run over its item budget", () => {
  const plan = {
    items: [
      {
        id: "1",
        text: "A",
        status: "pending" as const,
        budget: { tokens: 10_000 },
      },
      { id: "2", text: "B", status: "pending" as const },
    ],
    updatedAt: T0.toISOString(),
  };
  const fresh = () => createLoop(plan, { now: T0, sessionTokens: 0 });

  it("counts the running run with the earlier ones, and finds it over", () => {
    let loop = startItemRun(fresh(), "1", 0, T0, { sessionTokens: 1_000 });
    const item = plan.items[0];
    expect(
      itemBudgetStatus(loop, item, {
        sessionTokens: 9_200,
        now: minutes(1),
        turns: 3,
      }),
    ).toMatchObject({ state: "warn80", which: "tokens", used: 8_200 });
    expect(
      itemBudgetStatus(loop, item, {
        sessionTokens: 12_000,
        now: minutes(1),
        turns: 3,
      }),
    ).toMatchObject({ state: "over", which: "tokens", used: 11_000 });
    // An earlier run's tokens count too: 6,000 from the first run
    loop = finishItemRun(
      loop,
      { outcome: "later" },
      { sessionTokens: 7_000, now: minutes(1) },
    );
    loop = startItemRun(loop, "1", 0, minutes(2), { sessionTokens: 7_000 });
    expect(
      itemBudgetStatus(loop, item, {
        sessionTokens: 12_000,
        now: minutes(3),
        turns: 1,
      }),
    ).toMatchObject({ state: "over", which: "tokens", used: 11_000 });
  });

  it("ends as over budget: failed, work kept, not a failure of the loop's", () => {
    let loop = startItemRun(fresh(), "1", 0, T0, { sessionTokens: 0 });
    const breach = { which: "tokens" as const, used: 11_000, limit: 10_000 };
    loop = {
      ...loop,
      current: {
        ...loop.current!,
        overBudget: breach,
        report: overBudgetReport(breach),
      },
    };
    const done = finishItemRun(loop, loop.current!.report, {
      sessionTokens: 11_000,
      now: minutes(2),
    });
    const state = done.items.find((i) => i.id === "1")!;
    expect(state.status).toBe("failed");
    expect(state.overBudget).toEqual(breach);
    expect(state.summary).toContain("Over budget");
    expect(state.summary).toContain("11,000 of its 10,000 tokens");
    expect(done.consecutiveFailures ?? 0).toBe(0);
    expect(state.usage).toEqual({ tokens: 11_000, ms: 2 * 60_000 });
  });

  it("an ordinary stuck run still counts as a failure, and a new run clears the marker", () => {
    let loop = startItemRun(fresh(), "1", 0, T0);
    const stuck = finishItemRun(loop, { outcome: "stuck", summary: "no" });
    expect(stuck.consecutiveFailures).toBe(1);
    loop = startItemRun(
      {
        ...stuck,
        items: stuck.items.map((i) => ({
          ...i,
          overBudget: { which: "turns" as const, used: 1, limit: 1 },
        })),
      },
      "1",
      0,
      T0,
    );
    expect(loop.items[0].overBudget).toBeUndefined();
  });
});
