import { afterEach, describe, expect, it, vi } from "vitest";
import { AutocompleteDebouncer } from "./AutocompleteDebouncer";

describe("AutocompleteDebouncer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves superseded requests instead of leaving them pending", async () => {
    vi.useFakeTimers();
    const debouncer = new AutocompleteDebouncer();
    const pending = Array.from({ length: 20 }, () =>
      debouncer.delayAndShouldDebounce(50),
    );

    await vi.advanceTimersByTimeAsync(50);
    const results = await Promise.all(pending);

    expect(results.slice(0, 19).every((shouldDebounce) => shouldDebounce)).toBe(
      true,
    );
    expect(results[19]).toBe(false);
  });
});
