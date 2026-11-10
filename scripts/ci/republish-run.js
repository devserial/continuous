const { execFileSync } = require("child_process");

/** Only a finished successful run of Publish Extension may be republished. */
const WORKFLOW_PATH = ".github/workflows/main.yaml";
const ALLOWED_EVENTS = new Set(["release", "workflow_dispatch"]);

/**
 * @param {{ path?: string, event?: string, status?: string, conclusion?: string }} run
 */
function assertRepublishRun(run) {
  if (run.path !== WORKFLOW_PATH) {
    throw new Error(
      `Republish run workflow is ${run.path || "unknown"}; only ${WORKFLOW_PATH} can be republished`,
    );
  }
  if (!ALLOWED_EVENTS.has(run.event)) {
    throw new Error(
      `Republish run event is ${run.event || "unknown"}; only release and workflow_dispatch runs of this workflow can be republished`,
    );
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(
      `Republish run did not succeed (${run.status || "unknown"}/${run.conclusion || "unknown"})`,
    );
  }
}

/** @param {string} id */
function assertRunId(id) {
  if (!/^[0-9]+$/.test(String(id ?? ""))) {
    throw new Error("republish_run_id must be a numeric workflow run id");
  }
}

/** @param {string} repo */
function assertRepo(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo ?? ""))) {
    throw new Error("GH_REPO must be owner/name");
  }
}

function main() {
  const id = process.env.REPUBLISH_RUN_ID;
  const repo = process.env.GH_REPO;
  try {
    assertRunId(id);
    assertRepo(repo);
    const json = execFileSync(
      "gh",
      ["api", `repos/${repo}/actions/runs/${id}`],
      { encoding: "utf8" },
    );
    assertRepublishRun(JSON.parse(json));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  ALLOWED_EVENTS,
  WORKFLOW_PATH,
  assertRepo,
  assertRepublishRun,
  assertRunId,
};
