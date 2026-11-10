import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const provide = vi.fn();

vi.mock("./NextEditProvider", () => ({
  NextEditProvider: {
    getInstance: () => ({
      provideInlineCompletionItemsWithChain: provide,
    }),
  },
}));

import { PrefetchQueue } from "./NextEditPrefetchQueue";

function location(line: number) {
  return {
    filepath: "/tmp/a.ts",
    range: {
      start: { line, character: 0 },
      end: { line, character: 1 },
    },
  };
}

describe("PrefetchQueue", () => {
  beforeEach(() => {
    (PrefetchQueue as unknown as { instance: null }).instance = null;
    provide.mockReset();
  });

  afterEach(() => {
    PrefetchQueue.getInstance().abort();
  });

  it("drops a result that arrives after abort", async () => {
    let release: (value: unknown) => void = () => {};
    provide.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const queue = PrefetchQueue.getInstance(3);
    queue.enqueueUnprocessed(location(1));
    const running = queue.process({});
    await vi.waitFor(() => expect(provide).toHaveBeenCalledTimes(1));

    queue.abort();
    expect(queue.processedCount).toBe(0);
    release({ completion: "stale" });
    await running;
    expect(queue.processedCount).toBe(0);
  });

  it("does not run more requests than the prefetch limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    provide.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { completion: "ok" };
    });

    const queue = PrefetchQueue.getInstance(3);
    for (let i = 0; i < 6; i++) queue.enqueueUnprocessed(location(i));
    await Promise.all([
      queue.process({}),
      queue.process({}),
      queue.process({}),
      queue.process({}),
    ]);

    expect(queue.processedCount).toBe(3);
    expect(provide).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });
});
