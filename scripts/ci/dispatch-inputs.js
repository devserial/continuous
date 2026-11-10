const fs = require("fs");

/**
 * workflow_dispatch inputs used by the pre-release workflow.
 * Empty means "use the default" (main, or auto-increment the version).
 * @param {{ prereleaseVersion?: string, mainCommitSha?: string }} input
 */
function validateDispatchInputs(input) {
  const version = String(input.prereleaseVersion ?? "");
  const sha = String(input.mainCommitSha ?? "");
  if (version !== "" && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error("prerelease_version must be MAJOR.MINOR.PATCH");
  }
  if (sha !== "" && !/^[0-9a-fA-F]{40}$/.test(sha)) {
    throw new Error("main_commit_sha must be a 40-character hexadecimal SHA");
  }
  return {
    prereleaseVersion: version,
    ref: sha === "" ? "main" : sha.toLowerCase(),
  };
}

function main() {
  try {
    const result = validateDispatchInputs({
      prereleaseVersion: process.env.INPUT_PRERELEASE_VERSION,
      mainCommitSha: process.env.INPUT_MAIN_COMMIT_SHA,
    });
    const line = `ref=${result.ref}\nprerelease_version=${result.prereleaseVersion}\n`;
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
    } else {
      process.stdout.write(line);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { validateDispatchInputs };
