import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  decideReview,
} = require("../../../actions/general-review/scripts/decideReview.js");

describe("general-review authorization", () => {
  it("runs a non-draft pull request whose author has write access", () => {
    expect(
      decideReview({
        eventName: "pull_request",
        isDraft: false,
        prAuthorPermission: "write",
      }),
    ).toEqual({ shouldRun: true, skipReason: "" });
  });

  it("skips a draft", () => {
    expect(
      decideReview({
        eventName: "pull_request",
        isDraft: true,
        prAuthorPermission: "admin",
      }).shouldRun,
    ).toBe(false);
  });

  it("skips a pull request whose author cannot push", () => {
    expect(
      decideReview({
        eventName: "pull_request",
        prAuthorPermission: "read",
      }).skipReason,
    ).toMatch(/PR author/);
  });

  it("does not run when only the commenter has write access", () => {
    const decision = decideReview({
      eventName: "issue_comment",
      isPullRequestIssue: true,
      commentBody: "please @continue-review",
      commenterPermission: "write",
      prAuthorPermission: "read",
    });
    expect(decision.shouldRun).toBe(false);
    expect(decision.skipReason).toMatch(/PR author/);
  });

  it("runs a comment review when both the commenter and the author can push", () => {
    expect(
      decideReview({
        eventName: "issue_comment",
        isPullRequestIssue: true,
        commentBody: "@continue-review",
        commenterPermission: "maintain",
        prAuthorPermission: "admin",
      }).shouldRun,
    ).toBe(true);
  });

  it("skips a comment that is not the trigger on a pull request", () => {
    expect(
      decideReview({
        eventName: "issue_comment",
        isPullRequestIssue: false,
        commentBody: "@continue-review",
        commenterPermission: "write",
        prAuthorPermission: "write",
      }).shouldRun,
    ).toBe(false);
  });

  it("the action file refuses untrusted authors and does not grant Bash or fetch moving scripts", () => {
    const text = fs.readFileSync(
      path.join(__dirname, "../../../actions/general-review/action.yml"),
      "utf8",
    );
    expect(text).toContain("decideReview.js");
    expect(text).toContain("--exclude Bash");
    expect(text).not.toContain("--allow Bash");
    expect(text).not.toContain("continuedev/continue");
    expect(text).not.toContain("@continuedev/cli@latest");
    expect(text).toMatch(/Not safe for untrusted pull requests/i);
  });
});
