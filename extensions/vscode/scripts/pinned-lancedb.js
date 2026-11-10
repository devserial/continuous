const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** core's vectordb version. Platform packages in the lockfile must match it. */
const LANCEDB_VERSION = "0.21.2";

/**
 * npm has no @lancedb/vectordb-win32-arm64-msvc@0.21.2 (newest is 0.18.1).
 * Record that exact tarball instead of installing `latest`.
 */
const EXTRA_PINS = {
  "@lancedb/vectordb-win32-arm64-msvc": {
    version: "0.18.1",
    integrity:
      "sha512-qgmGKqTjROX8SJAb3TJ/PBLbnffLs22qm4CwxpzvTywJZAOyvqx/KrXkIG+6csoXCS5MhFnyIFonOQ6wXf9rpA==",
  },
};

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function defaultLockPath() {
  return path.join(__dirname, "../../../core/package-lock.json");
}

/** @param {string} spec `@scope/name` or `@scope/name@version` */
function stripVersion(spec) {
  const name = String(spec ?? "");
  const slash = name.indexOf("/");
  const at = name.lastIndexOf("@");
  if (at > slash) return name.slice(0, at);
  return name;
}

/**
 * The version and integrity a LanceDB native package may be installed at.
 * Lockfile entries win. Anything else is refused, except the recorded
 * win32-arm64 pin above.
 * @param {string} packageName
 * @param {{ packages?: Record<string, { version?: string, integrity?: string }> }} lock
 */
function expectedLancedbPin(packageName, lock) {
  const name = stripVersion(packageName);
  if (!name.startsWith("@lancedb/vectordb-")) {
    throw new Error(
      `Refusing to install unpinned package ${packageName || "(empty)"}`,
    );
  }
  const entry = lock?.packages?.[`node_modules/${name}`];
  if (entry?.integrity && entry.version === LANCEDB_VERSION) {
    return {
      name,
      version: LANCEDB_VERSION,
      spec: `${name}@${LANCEDB_VERSION}`,
      integrity: entry.integrity,
    };
  }
  const extra = EXTRA_PINS[name];
  if (extra) {
    return {
      name,
      version: extra.version,
      spec: `${name}@${extra.version}`,
      integrity: extra.integrity,
    };
  }
  throw new Error(
    `${name}@${LANCEDB_VERSION} is not in the lockfile; refusing to install an unpinned native package`,
  );
}

/**
 * @param {string} actual integrity from `npm pack`
 * @param {string} expected integrity from the pin
 * @param {string} spec
 */
function assertIntegrity(actual, expected, spec) {
  if (actual !== expected) {
    throw new Error(
      `Integrity mismatch for ${spec}: expected ${expected}, got ${actual}`,
    );
  }
}

/**
 * Install one pinned LanceDB native package into `cwd` (a throwaway project).
 * Packs the pinned spec, checks it against the lockfile (or EXTRA_PINS), then
 * `npm install --force <tarball> --no-save` so the registry's `latest` is never used.
 * @param {string} packageName
 * @param {string} cwd
 * @param {{ lockPath?: string }} [options]
 */
function installPinnedLancedb(packageName, cwd, options = {}) {
  const lockPath = options.lockPath ?? defaultLockPath();
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const pin = expectedLancedbPin(packageName, lock);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "continuous-lancedb-"));
  const shell = process.platform === "win32";
  try {
    const packed = JSON.parse(
      execFileSync(
        npmBin(),
        ["pack", pin.spec, "--json", "--pack-destination", dir],
        { encoding: "utf8", shell },
      ),
    )[0];
    assertIntegrity(packed.integrity, pin.integrity, pin.spec);
    const tarball = path.join(dir, packed.filename);
    execFileSync(npmBin(), ["init", "-y"], { cwd, stdio: "inherit", shell });
    execFileSync(npmBin(), ["install", "--force", tarball, "--no-save"], {
      cwd,
      stdio: "inherit",
      shell,
    });
    return pin;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  EXTRA_PINS,
  LANCEDB_VERSION,
  assertIntegrity,
  expectedLancedbPin,
  installPinnedLancedb,
  stripVersion,
};
