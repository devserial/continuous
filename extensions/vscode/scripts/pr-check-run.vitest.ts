import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  selectPrCheckRun,
} = require("../../../scripts/ci/select-pr-check-run.js");

const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function run(over: Record<string, unknown>) {
  return {
    databaseId: 10,
    status: "completed",
    conclusion: "success",
    headSha: head,
    event: "pull_request",
    ...over,
  };
}

describe("selectPrCheckRun", () => {
  it("selects the successful pull_request run for this head SHA", () => {
    expect(
      selectPrCheckRun(
        [run({ databaseId: 1, headSha: other }), run({ databaseId: 2 })],
        head,
      ),
    ).toBe("2");
  });

  it("does not select a same-branch run with a different head SHA", () => {
    expect(selectPrCheckRun([run({ headSha: other })], head)).toBe("");
  });

  it("does not select a push run of the same SHA", () => {
    expect(selectPrCheckRun([run({ event: "push" })], head)).toBe("");
  });

  it("does not select a failed run", () => {
    expect(selectPrCheckRun([run({ conclusion: "failure" })], head)).toBe("");
  });

  it("rejects a head SHA that is not 40 hex characters", () => {
    expect(() => selectPrCheckRun([], "main")).toThrow(/40-character/);
  });
});
