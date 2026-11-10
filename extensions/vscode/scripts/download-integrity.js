const crypto = require("crypto");

const SQLITE_VERSION = "v5.1.7";

/**
 * SHA-256 of every native archive a release build downloads.
 * esbuild zips previously fetched from the same bucket are not listed: those
 * objects are not published, and a URL with no pin is refused.
 */
const DOWNLOAD_SHA256 = {
  "https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.7/sqlite3-v5.1.7-napi-v6-darwin-arm64.tar.gz":
    "84a34404b12ff212adbca70eff76c2e4dd83b91245eed0b4569438f928567afc",
  "https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.7/sqlite3-v5.1.7-napi-v6-darwin-x64.tar.gz":
    "5f4662107faf0a9d15d00661be6ae1fb09ce3f85c109a3552e1771d48083b43d",
  "https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.7/sqlite3-v5.1.7-napi-v6-linux-arm64.tar.gz":
    "0f112c63a74bebdffce298792c264b3af4b85d7fe1975a4bca1227438f531dbb",
  "https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.7/sqlite3-v5.1.7-napi-v6-linux-x64.tar.gz":
    "6d1f7a95e5aca90db1fd6a2839380a021d5ee23d46f2d7c520ded094da813fed",
  "https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.7/sqlite3-v5.1.7-napi-v6-win32-x64.tar.gz":
    "7a55f7adb5fc3126156c56253511ec5ac38110531281ecbafbe71244555e93ce",
  "https://continue-server-binaries.s3.us-west-1.amazonaws.com/win32-arm64/node_sqlite3.tar.gz":
    "f2cb741598e32594793ba827fda8560b9eaca95f0b97192fe063b32c3d409506",
};

/** @param {string} target packaging target, e.g. "linux-x64" */
function sqliteDownloadUrl(target) {
  // node-sqlite3 publishes no win32-arm64 build; that archive is pinned separately.
  if (target === "win32-arm64") {
    return "https://continue-server-binaries.s3.us-west-1.amazonaws.com/win32-arm64/node_sqlite3.tar.gz";
  }
  return `https://github.com/TryGhost/node-sqlite3/releases/download/${SQLITE_VERSION}/sqlite3-${SQLITE_VERSION}-napi-v6-${target}.tar.gz`;
}

/** @param {string} target packaging target */
function esbuildDownloadUrl(target) {
  return `https://continue-server-binaries.s3.us-west-1.amazonaws.com/${target}/esbuild.zip`;
}

/** @param {Buffer | Uint8Array | string} bytes */
function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Refuse a native download that has no pin, or whose bytes don't match it.
 * @param {string} url
 * @param {Buffer | Uint8Array | string} bytes
 */
function assertDownloadSha256(url, bytes) {
  const expected = DOWNLOAD_SHA256[url];
  if (!expected) {
    throw new Error(
      `No SHA-256 pin for ${url}. Refusing to unpack an unpinned native download.`,
    );
  }
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch for ${url}: expected ${expected}, got ${actual}`,
    );
  }
}

module.exports = {
  DOWNLOAD_SHA256,
  SQLITE_VERSION,
  assertDownloadSha256,
  esbuildDownloadUrl,
  sha256,
  sqliteDownloadUrl,
};
