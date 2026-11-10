const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/** @param {string | undefined} permission */
function hasWriteAccess(permission) {
  return WRITE_PERMISSIONS.has(permission);
}

/**
 * Whether this action may run the review agent.
 * On a comment, the commenter's permission is not enough: the pull request
 * author must have write access too. A pull request from someone who cannot
 * push is not reviewed.
 * @param {{
 *   eventName?: string,
 *   isDraft?: boolean,
 *   prAuthorPermission?: string,
 *   commenterPermission?: string,
 *   commentBody?: string,
 *   isPullRequestIssue?: boolean,
 * }} input
 */
function decideReview(input) {
  const eventName = input.eventName;
  if (eventName === "pull_request") {
    if (input.isDraft) {
      return { shouldRun: false, skipReason: "PR is a draft" };
    }
    if (!hasWriteAccess(input.prAuthorPermission)) {
      return {
        shouldRun: false,
        skipReason: "PR author does not have write permission",
      };
    }
    return { shouldRun: true, skipReason: "" };
  }
  if (eventName === "issue_comment") {
    const hasTrigger = String(input.commentBody ?? "").includes(
      "@continue-review",
    );
    if (!(input.isPullRequestIssue && hasTrigger)) {
      return {
        shouldRun: false,
        skipReason:
          "Comment does not contain @continue-review trigger, or is not on a PR",
      };
    }
    if (!hasWriteAccess(input.commenterPermission)) {
      return {
        shouldRun: false,
        skipReason: "Commenter does not have write permission",
      };
    }
    if (!hasWriteAccess(input.prAuthorPermission)) {
      return {
        shouldRun: false,
        skipReason: "PR author does not have write permission",
      };
    }
    return { shouldRun: true, skipReason: "" };
  }
  return {
    shouldRun: false,
    skipReason: `Unsupported event type: ${eventName}`,
  };
}

module.exports = { decideReview, hasWriteAccess };
