import { describe, expect, it } from "vitest";
import { fairShareOf, sizeWeight, splitBudget } from "./loopBudgetSplit";

const items = (...ids: string[]) => ids.map((id) => ({ id }));
const tokensOf = (r: ReturnType<typeof splitBudget>) =>
  Object.fromEntries(
    Object.entries(r.budgets).map(([id, b]) => [id, b.tokens]),
  );

describe("splitBudget", () => {
  const totals = { tokens: 900_000, minutes: 90 };

  it("does nothing under none, except cap and keep an item's own budget", () => {
    const r = splitBudget(totals, items("1", "2"), { strategy: "none" });
    expect(r.budgets).toEqual({ "1": {}, "2": {} });
    expect(r.reserve).toEqual({});
  });

  it("equal: the same share each", () => {
    const r = splitBudget(totals, items("1", "2", "3"), { strategy: "equal" });
    expect(tokensOf(r)).toEqual({ "1": 300_000, "2": 300_000, "3": 300_000 });
    expect(r.budgets["1"].minutes).toBe(30);
  });

  it("weighted: shares follow the weights, S M L as 1 2 4", () => {
    expect(sizeWeight("s")).toBe(1);
    expect(sizeWeight("M")).toBe(2);
    expect(sizeWeight("L")).toBe(4);
    expect(sizeWeight("huge")).toBe(1);
    const r = splitBudget(
      { tokens: 700_000 },
      [
        { id: "a", weight: 1 },
        { id: "b", weight: 2 },
        { id: "c", weight: 4 },
      ],
      { strategy: "weighted" },
    );
    expect(tokensOf(r)).toEqual({ a: 100_000, b: 200_000, c: 400_000 });
  });

  it("fair share: a third or 1/n of what is left, never more than is left, shrinking as it goes", () => {
    expect(fairShareOf(900, 10)).toBe(300); // a third beats 1/10
    expect(fairShareOf(900, 2)).toBe(450); // 1/2 beats a third
    expect(fairShareOf(900, 1)).toBe(900);
    expect(fairShareOf(0, 3)).toBe(0);
    const r = splitBudget({ tokens: 900 }, items("1", "2", "3", "4"), {
      strategy: "fair-share",
    });
    // 900/3, then 600/3, then 400/2, then all that is left
    expect(tokensOf(r)).toEqual({ "1": 300, "2": 200, "3": 200, "4": 200 });
  });

  it("reserve holds back a fraction before the split", () => {
    const r = splitBudget(
      { tokens: 1_000_000, minutes: 100 },
      items("1", "2"),
      {
        strategy: "equal",
        reserve: 0.2,
      },
    );
    expect(r.reserve).toEqual({ tokens: 200_000, minutes: 20 });
    expect(tokensOf(r)).toEqual({ "1": 400_000, "2": 400_000 });
  });

  it("clamps the reserve to 0 to 90 percent", () => {
    expect(
      splitBudget({ tokens: 100 }, items("1"), {
        strategy: "equal",
        reserve: 5,
      }).reserve,
    ).toEqual({ tokens: 90 });
    expect(
      splitBudget({ tokens: 100 }, items("1"), {
        strategy: "equal",
        reserve: -1,
      }).reserve,
    ).toEqual({});
  });

  it("an item's own budget wins, is capped at what is left, and the others share the rest", () => {
    const r = splitBudget(
      { tokens: 1_000_000 },
      [
        { id: "own", budget: { tokens: 600_000, turns: 20 } },
        { id: "x" },
        { id: "y" },
      ],
      { strategy: "equal" },
    );
    expect(r.budgets.own).toEqual({ tokens: 600_000, turns: 20 });
    expect(tokensOf(r)).toMatchObject({ x: 200_000, y: 200_000 });
    const capped = splitBudget(
      { tokens: 100 },
      [{ id: "big", budget: { tokens: 500 } }],
      {
        strategy: "equal",
      },
    );
    expect(capped.budgets.big.tokens).toBe(100);
  });

  it("has nothing to divide without a limit, and keeps minutes at least 1", () => {
    const none = splitBudget({ tokens: 0 }, items("1", "2"), {
      strategy: "equal",
    });
    expect(none.budgets["1"]).toEqual({});
    const tiny = splitBudget({ minutes: 1 }, items("1", "2", "3"), {
      strategy: "equal",
    });
    expect(tiny.budgets["1"].minutes).toBe(1);
  });

  it("an item left out of the share leaves it to the rest (explicit turns are not divided)", () => {
    const r = splitBudget(
      { tokens: 300 },
      [{ id: "1", budget: { turns: 5 } }, { id: "2" }],
      {
        strategy: "equal",
      },
    );
    expect(r.budgets["1"]).toEqual({ turns: 5, tokens: 150 });
  });
});
