const { execFileSync } = require("child_process");
const fs = require("fs");

/**
 * Pick a successful pull_request run of PR Checks whose head SHA is this PR's.
 * Branch name is not used: two pulls can share a branch name.
 * @param {Array<{ databaseId?: number | string, status?: string, conclusion?: string, headSha?: string, event?: string }>} runs
 * @param {string} headSha
 * @returns {string} run id, or "" when none match
 */
function selectPrCheckRun(runs, headSha) {
  if (!/^[0-9a-fA-F]{40}$/.test(String(headSha ?? ""))) {
    throw new Error("PR head SHA must be a 40-character hexadecimal SHA");
  }
  const sha = String(headSha).toLowerCase();
  const match = (runs || []).find(
    (run) =>
      run &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      String(run.headSha || "").toLowerCase() === sha &&
      run.event === "pull_request" &&
      /^[0-9]+$/.test(String(run.databaseId ?? "")),
  );
  return match ? String(match.databaseId) : "";
}

function assertRepo(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo ?? ""))) {
    throw new Error("GH_REPO must be owner/name");
  }
}

function assertPrNumber(prNumber) {
  if (!/^[0-9]+$/.test(String(prNumber ?? ""))) {
    throw new Error("PR number must be numeric");
  }
}

function main() {
  const repo = process.env.GH_REPO;
  const prNumber = process.env.PR_NUMBER;
  try {
    assertRepo(repo);
    assertPrNumber(prNumber);
    const pr = JSON.parse(
      execFileSync(
        "gh",
        ["pr", "view", prNumber, "--repo", repo, "--json", "headRefOid"],
        { encoding: "utf8" },
      ),
    );
    const runs = JSON.parse(
      execFileSync(
        "gh",
        [
          "run",
          "list",
          "--repo",
          repo,
          "--workflow",
          "pr-checks.yaml",
          "--commit",
          pr.headRefOid,
          "--event",
          "pull_request",
          "--json",
          "databaseId,status,conclusion,headSha,event",
          "--limit",
          "20",
        ],
        { encoding: "utf8" },
      ),
    );
    const id = selectPrCheckRun(runs, pr.headRefOid);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${id}\n`);
    }
    if (!id) {
      console.log(
        `::notice::No successful PR Checks run for PR #${prNumber} at ${pr.headRefOid}; skipping artifact republish`,
      );
    } else {
      console.log(`Found successful workflow run: ${id}`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { selectPrCheckRun };
