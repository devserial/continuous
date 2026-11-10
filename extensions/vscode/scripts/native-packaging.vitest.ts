import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const integrity = require("./download-integrity.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lancedb = require("./pinned-lancedb.js");

const PACKAGED_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
  "win32-arm64",
];

describe("native download pins", () => {
  it("pins a SHA-256 for every sqlite archive a release target downloads", () => {
    for (const target of PACKAGED_TARGETS) {
      const url = integrity.sqliteDownloadUrl(target);
      expect(integrity.DOWNLOAD_SHA256[url]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refuses an esbuild zip, which has no pin", () => {
    const url = integrity.esbuildDownloadUrl("linux-x64");
    expect(() =>
      integrity.assertDownloadSha256(url, Buffer.from("nope")),
    ).toThrow(/No SHA-256 pin/);
  });

  it("refuses bytes that do not match the pin", () => {
    const url = integrity.sqliteDownloadUrl("linux-x64");
    expect(() =>
      integrity.assertDownloadSha256(url, Buffer.from("tampered")),
    ).toThrow(/SHA-256 mismatch/);
  });

  it("accepts bytes that match the recorded pin", () => {
    const url = integrity.sqliteDownloadUrl("linux-x64");
    const bytes = Buffer.from("sqlite-archive");
    const digest = createHash("sha256").update(bytes).digest("hex");
    integrity.DOWNLOAD_SHA256[url] = digest;
    try {
      expect(() => integrity.assertDownloadSha256(url, bytes)).not.toThrow();
    } finally {
      integrity.DOWNLOAD_SHA256[url] =
        "6d1f7a95e5aca90db1fd6a2839380a021d5ee23d46f2d7c520ded094da813fed";
    }
  });

  it("records the linux-x64 archive hash checked into the pin map", () => {
    expect(
      integrity.DOWNLOAD_SHA256[integrity.sqliteDownloadUrl("linux-x64")],
    ).toBe("6d1f7a95e5aca90db1fd6a2839380a021d5ee23d46f2d7c520ded094da813fed");
  });
});

describe("pinned LanceDB install", () => {
  const lock = {
    packages: {
      "node_modules/@lancedb/vectordb-linux-x64-gnu": {
        version: "0.21.2",
        integrity: "sha512-from-lock",
      },
    },
  };

  it("uses core's 0.21.2 integrity from the lockfile", () => {
    expect(
      lancedb.expectedLancedbPin("@lancedb/vectordb-linux-x64-gnu", lock),
    ).toEqual({
      name: "@lancedb/vectordb-linux-x64-gnu",
      version: "0.21.2",
      spec: "@lancedb/vectordb-linux-x64-gnu@0.21.2",
      integrity: "sha512-from-lock",
    });
  });

  it("ignores a version someone appended and still uses the pin", () => {
    expect(
      lancedb.expectedLancedbPin("@lancedb/vectordb-linux-x64-gnu@9.9.9", lock)
        .version,
    ).toBe("0.21.2");
  });

  it("refuses a platform package the lockfile does not pin", () => {
    expect(() =>
      lancedb.expectedLancedbPin("@lancedb/vectordb-freebsd-x64", lock),
    ).toThrow(/not in the lockfile/);
  });

  it("refuses a package that is not a LanceDB native build", () => {
    expect(() => lancedb.expectedLancedbPin("esbuild", lock)).toThrow(
      /Refusing to install unpinned package/,
    );
  });

  it("pins win32-arm64 to the published 0.18.1 tarball, not latest", () => {
    const pin = lancedb.expectedLancedbPin(
      "@lancedb/vectordb-win32-arm64-msvc",
      { packages: {} },
    );
    expect(pin.version).toBe("0.18.1");
    expect(pin.integrity).toMatch(/^sha512-/);
  });

  it("rejects a pack integrity that does not match the pin", () => {
    expect(() =>
      lancedb.assertIntegrity("sha512-other", "sha512-pin", "pkg@1"),
    ).toThrow(/Integrity mismatch/);
  });

  it("reads the real core lockfile for linux-x64 at 0.21.2", () => {
    const lockPath = path.join(__dirname, "../../../core/package-lock.json");
    const real = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const pin = lancedb.expectedLancedbPin(
      "@lancedb/vectordb-linux-x64-gnu",
      real,
    );
    expect(pin).toMatchObject({
      version: "0.21.2",
      integrity:
        "sha512-5I2drMOIyRODlAHPsipQBTrRRgcOZ45N5GsuhqcKnz3Tg8GAdc1MQKyK3BrdJzKHLPdRtIyRJ6QTLB3wZvDsQQ==",
    });
  });
});
