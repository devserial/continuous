import { describe, expect, it } from "vitest";
import {
  createLoop,
  finishItemRun,
  finishParallelRun,
  startItemRun,
  startParallelRun,
} from "./loopMode";
import {
  describeRoundUsage,
  describeTimeUsage,
  describeTokenUsage,
  formatDuration,
  formatTokenCount,
  loopUsage,
} from "./loopUsage";

const T0 = new Date("2026-11-09T10:00:00Z");
const plan = {
  items: [
    { id: "1", text: "A", status: "pending" as const },
    { id: "2", text: "B", status: "pending" as const },
    { id: "3", text: "C", status: "pending" as const },
  ],
  updatedAt: T0.toISOString(),
};
const loopWith = (budget = {}) => {
  const loop = createLoop(plan, { now: T0, sessionTokens: 1_000 });
  return { ...loop, budget: { ...loop.budget, ...budget } };
};
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe("loopUsage", () => {
  it("counts what the loop used and what is left of each limit", () => {
    const loop = loopWith({
      maxRounds: 3,
      maxTokens: 10_000_000,
      maxWallMs: 2 * 60 * 60_000,
    });
    const u = loopUsage(loop, { sessionTokens: 1_201_000, now: minutes(19) });
    expect(u.tokens).toMatchObject({ used: 1_200_000, left: 8_800_000 });
    expect(u.tokens.fraction).toBeCloseTo(0.12);
    expect(u.time).toMatchObject({ used: 19 * 60_000, left: 101 * 60_000 });
    expect(u.rounds).toMatchObject({ used: 1, max: 3 });
    expect(u.items).toEqual({ done: 0, total: 3 });
  });

  it("has nothing left to count down without a limit, and never goes negative", () => {
    const loop = loopWith({ maxTokens: 0, maxWallMs: 0 });
    const u = loopUsage(loop, { sessionTokens: 5_000, now: minutes(5) });
    expect(u.tokens.left).toBeUndefined();
    expect(u.tokens.fraction).toBeUndefined();
    expect(u.time.left).toBeUndefined();
    const over = loopUsage(loopWith({ maxTokens: 10_000 }), {
      sessionTokens: 999_999,
      now: T0,
    });
    expect(over.tokens.left).toBe(0);
    expect(over.tokens.fraction).toBe(1);
  });

  it("totals runs and lists them per item, skipped items not counted as done", () => {
    const loop = loopWith();
    loop.items[0] = { ...loop.items[0], status: "done", attempts: 1 };
    loop.items[1] = {
      ...loop.items[1],
      status: "done",
      attempts: 2,
      skipped: true,
    };
    loop.items[2] = { ...loop.items[2], status: "failed", attempts: 3 };
    const u = loopUsage(loop, { sessionTokens: 1_000, now: T0 });
    expect(u.runs).toBe(6);
    expect(u.items).toEqual({ done: 1, total: 3 });
    expect(u.perItem).toEqual([
      { id: "1", runs: 1, status: "done" },
      { id: "2", runs: 2, status: "done" },
      { id: "3", runs: 3, status: "failed" },
    ]);
  });
});

describe("formatting", () => {
  it("shortens token counts and durations", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(1_234)).toBe("1.2K");
    expect(formatTokenCount(12_345)).toBe("12K");
    expect(formatTokenCount(8_800_000)).toBe("8.8M");
    expect(formatTokenCount(10_000_000)).toBe("10M");
    expect(formatDuration(30_000)).toBe("under 1m");
    expect(formatDuration(41 * 60_000)).toBe("41m");
    expect(formatDuration(101 * 60_000)).toBe("1h 41m");
    expect(formatDuration(120 * 60_000)).toBe("2h");
  });

  it("describes each limit with and without a cap", () => {
    const loop = loopWith({
      maxRounds: 3,
      maxTokens: 10_000_000,
      maxWallMs: 7_200_000,
    });
    const u = loopUsage(loop, { sessionTokens: 1_201_000, now: minutes(19) });
    expect(describeTokenUsage(u.tokens)).toBe("8.8M left of 10M");
    expect(describeTimeUsage(u.time)).toBe("1h 41m left of 2h");
    expect(describeRoundUsage(u.rounds)).toBe("Round 1 of 3");
    const free = loopUsage(
      loopWith({ maxRounds: 0, maxTokens: 0, maxWallMs: 0 }),
      {
        sessionTokens: 61_000,
        now: minutes(19),
      },
    );
    expect(describeTokenUsage(free.tokens)).toBe("60K used");
    expect(describeTimeUsage(free.time)).toBe("19m in");
    expect(describeRoundUsage(free.rounds)).toBe("Round 1");
  });
});

describe("per-item usage", () => {
  const usageOf = (loop: ReturnType<typeof loopWith>, id: string) =>
    loop.items.find((i) => i.id === id)?.usage;

  it("counts a run's own tokens and time, and adds a second run's", () => {
    let loop = loopWith();
    loop = startItemRun(loop, "1", 0, T0, { sessionTokens: 1_000 });
    loop = finishItemRun(
      loop,
      { outcome: "later" },
      { sessionTokens: 4_000, now: minutes(3) },
    );
    expect(usageOf(loop, "1")).toEqual({ tokens: 3_000, ms: 3 * 60_000 });
    loop = startItemRun(loop, "1", 0, minutes(10), { sessionTokens: 4_000 });
    loop = finishItemRun(
      loop,
      { outcome: "done" },
      { sessionTokens: 4_500, now: minutes(12) },
    );
    expect(usageOf(loop, "1")).toEqual({ tokens: 3_500, ms: 5 * 60_000 });
  });

  it("records only what it was given", () => {
    let loop = loopWith();
    loop = startItemRun(loop, "1", 0, T0);
    loop = finishItemRun(loop, { outcome: "done" }, { now: minutes(2) });
    expect(usageOf(loop, "1")).toEqual({ tokens: 0, ms: 2 * 60_000 });
    loop = startItemRun(loop, "2", 0, T0);
    loop = finishItemRun(loop, { outcome: "done" });
    expect(usageOf(loop, "2")).toBeUndefined();
  });

  it("counts a parallel worker's time from its start and the tokens it reports", () => {
    let loop = loopWith();
    loop = startParallelRun(loop, "3", T0);
    loop = finishParallelRun(
      loop,
      "3",
      { report: { outcome: "done" }, tokens: 7_500 },
      minutes(6),
    );
    expect(usageOf(loop, "3")).toEqual({ tokens: 7_500, ms: 6 * 60_000 });
  });

  it("is in the usage's per-item list", () => {
    let loop = loopWith();
    loop = startItemRun(loop, "1", 0, T0, { sessionTokens: 1_000 });
    loop = finishItemRun(
      loop,
      { outcome: "done" },
      { sessionTokens: 2_000, now: minutes(1) },
    );
    const u = loopUsage(loop, { sessionTokens: 2_000, now: minutes(1) });
    expect(u.perItem[0]).toMatchObject({
      id: "1",
      runs: 1,
      tokens: 1_000,
      ms: 60_000,
    });
    expect(u.perItem[1].tokens).toBeUndefined();
  });
});
