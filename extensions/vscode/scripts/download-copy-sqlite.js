const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");

const { ProxyAgent } = require("undici");
const { rimrafSync } = require("rimraf");

const { execCmdSync } = require("../../../scripts/util");
const {
  SQLITE_VERSION,
  assertDownloadSha256,
  esbuildDownloadUrl,
  sqliteDownloadUrl,
} = require("./download-integrity");

// GitHub's 504 bursts have outlasted four attempts (2s + 4s + 8s); six give about a minute.
const FETCH_ATTEMPTS = 6;

/** fetch, trying again after a server error or a dropped connection. */
async function fetchWithRetry(url, options) {
  for (let attempt = 1; ; attempt++) {
    let problem;
    try {
      const response = await fetch(url, options);
      if (response.status < 500 || attempt === FETCH_ATTEMPTS) return response;
      problem = `status code: ${response.status}`;
    } catch (error) {
      if (attempt === FETCH_ATTEMPTS) throw error;
      problem = error.message;
    }
    const waitMs = 2000 * 2 ** (attempt - 1);
    console.warn(
      `[warn] Download failed (${problem}), trying again in ${waitMs / 1000}s`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * download a file using fetch API
 * @param {string} url
 * @param {string} outputPath
 */
async function downloadFile(url, outputPath) {
  // Use proxy if set in environment variables
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  const agent = proxy ? new ProxyAgent(proxy) : undefined;

  const response = await fetchWithRetry(url, {
    redirect: "follow", // Automatically follow redirects
    dispatcher: agent,
  });

  if (!response.ok) {
    throw new Error(`Failed to download file, status code: ${response.status}`);
  }

  // Create output directory if it doesn't exist
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Check the pin before anything is written or unpacked.
  const buffer = Buffer.from(await response.arrayBuffer());
  assertDownloadSha256(url, buffer);
  fs.writeFileSync(outputPath, buffer);
}

/**
 *
 * @param {string} target platform specific target
 * @param {string} targetDir the directory to download into
 */
async function downloadSqlite(target, targetDir) {
  await downloadFile(sqliteDownloadUrl(target), targetDir);
}

async function installAndCopySqlite(target) {
  // A build restored from the CI cache already holds this target's pre-built binary;
  // the marker says which release and target it is.
  const buildDir = "../../core/node_modules/sqlite3/build";
  const marker = path.join(buildDir, `.prebuilt-${SQLITE_VERSION}-${target}`);
  if (fs.existsSync(marker)) {
    console.log("[info] Using cached pre-built sqlite3 binary");
    return;
  }

  // Replace the installed with pre-built
  console.log("[info] Downloading pre-built sqlite3 binary");
  rimrafSync(buildDir);
  await downloadSqlite(target, "../../core/node_modules/sqlite3/build.tar.gz");
  execCmdSync("cd ../../core/node_modules/sqlite3 && tar -xvzf build.tar.gz");
  fs.unlinkSync("../../core/node_modules/sqlite3/build.tar.gz");
  fs.writeFileSync(marker, "");
}

async function installAndCopyEsbuild(target) {
  // Download and unzip esbuild
  console.log("[info] Downloading pre-built esbuild binary");
  rimrafSync("node_modules/@esbuild");
  fs.mkdirSync("node_modules/@esbuild", { recursive: true });
  await downloadFile(
    esbuildDownloadUrl(target),
    "node_modules/@esbuild/esbuild.zip",
  );
  execCmdSync("cd node_modules/@esbuild && unzip esbuild.zip");
  fs.unlinkSync("node_modules/@esbuild/esbuild.zip");
}

process.on("message", (msg) => {
  const { operation, target } = msg.payload;
  if (operation === "sqlite") {
    installAndCopySqlite(target)
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  }
  if (operation === "esbuild") {
    installAndCopyEsbuild(target)
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  }
});

/**
 * @param {string} target the platform to build for
 */
async function copySqlite(target) {
  const child = fork(__filename, { stdio: "inherit", cwd: process.cwd() });
  child.send({
    payload: {
      operation: "sqlite",
      target,
    },
  });

  return new Promise((resolve, reject) => {
    child.on("message", (msg) => {
      if (msg.error) {
        reject();
      } else {
        resolve();
      }
    });
  });
}

/**
 * @param {string} target the platform to build for
 */
async function copyEsbuild(target) {
  const child = fork(__filename, { stdio: "inherit", cwd: process.cwd() });
  child.send({
    payload: {
      operation: "esbuild",
      target,
    },
  });

  return new Promise((resolve, reject) => {
    child.on("message", (msg) => {
      if (msg.error) {
        reject();
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  downloadSqlite,
  copySqlite,
  copyEsbuild,
};
