import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  assertRepublishRun,
  assertRunId,
} = require("../../../scripts/ci/republish-run.js");

const good = {
  path: ".github/workflows/main.yaml",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
};

describe("republish run check", () => {
  it("accepts a successful workflow_dispatch of Publish Extension", () => {
    expect(() => assertRepublishRun(good)).not.toThrow();
  });

  it("accepts a successful release of the same workflow", () => {
    expect(() =>
      assertRepublishRun({ ...good, event: "release" }),
    ).not.toThrow();
  });

  it("rejects a pull request run, including one that uploaded vsix artifacts", () => {
    expect(() =>
      assertRepublishRun({
        path: ".github/workflows/pr-build-upload-vsix.yaml",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
      }),
    ).toThrow(/only \.github\/workflows\/main\.yaml/);
  });

  it("rejects this workflow when a pull request triggered it", () => {
    expect(() =>
      assertRepublishRun({ ...good, event: "pull_request" }),
    ).toThrow(/only release and workflow_dispatch/);
  });

  it("rejects a run that did not succeed", () => {
    expect(() =>
      assertRepublishRun({ ...good, conclusion: "failure" }),
    ).toThrow(/did not succeed/);
  });

  it("rejects a run id that is not numeric", () => {
    expect(() => assertRunId("123; rm -rf")).toThrow(/numeric/);
    expect(() => assertRunId("42737804736")).not.toThrow();
  });
});
