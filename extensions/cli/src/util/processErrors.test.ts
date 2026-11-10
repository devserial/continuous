import { beforeEach, describe, expect, it, vi } from "vitest";

const { gracefulExit } = vi.hoisted(() => ({
  gracefulExit: vi.fn(async () => {}),
}));

vi.mock("./exit.js", () => ({
  gracefulExit,
}));

vi.mock("./logger.js", () => ({
  logger: { error: vi.fn(), debug: vi.fn() },
}));

import { hadUnhandledError } from "./errorState.js";
import { exitBecause } from "./processErrors.js";

describe("exitBecause", () => {
  beforeEach(() => {
    gracefulExit.mockClear();
  });

  it("records the failure and exits non-zero", async () => {
    exitBecause(new Error("listen EADDRINUSE"), "Server failed to listen:");
    await vi.waitFor(() => expect(gracefulExit).toHaveBeenCalledWith(1));
    expect(hadUnhandledError()).toBe(true);
  });
});
