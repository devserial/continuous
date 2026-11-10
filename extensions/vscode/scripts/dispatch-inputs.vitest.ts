import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  validateDispatchInputs,
} = require("../../../scripts/ci/dispatch-inputs.js");

const root = path.join(__dirname, "../../..");

describe("pre-release dispatch inputs", () => {
  it("defaults an empty SHA to main and keeps an empty version", () => {
    expect(
      validateDispatchInputs({ prereleaseVersion: "", mainCommitSha: "" }),
    ).toEqual({ prereleaseVersion: "", ref: "main" });
  });

  it("accepts a semver and a 40-character SHA", () => {
    expect(
      validateDispatchInputs({
        prereleaseVersion: "1.3.15",
        mainCommitSha: "ABCDEF0123456789abcdef0123456789abcdef01",
      }),
    ).toEqual({
      prereleaseVersion: "1.3.15",
      ref: "abcdef0123456789abcdef0123456789abcdef01",
    });
  });

  it("rejects a version that is not MAJOR.MINOR.PATCH", () => {
    expect(() =>
      validateDispatchInputs({
        prereleaseVersion: "1.2.3; touch /tmp/x",
        mainCommitSha: "",
      }),
    ).toThrow(/MAJOR\.MINOR\.PATCH/);
  });

  it("passes workflow_dispatch inputs only through env assignments", () => {
    const text = fs.readFileSync(
      path.join(root, ".github/workflows/vscode-prerelease.yml"),
      "utf8",
    );
    const inputLines = text
      .split("\n")
      .filter((line) => line.includes("${{ inputs."));
    expect(inputLines.length).toBeGreaterThan(0);
    for (const line of inputLines) {
      expect(line.trim().startsWith("INPUT_")).toBe(true);
    }
  });

  it("rejects a SHA that is not 40 hex characters", () => {
    expect(() =>
      validateDispatchInputs({
        prereleaseVersion: "",
        mainCommitSha: "main; echo pwned",
      }),
    ).toThrow(/40-character/);
  });
});
