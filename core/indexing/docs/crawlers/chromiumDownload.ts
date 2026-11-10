import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * Pinned Chromium snapshot archives. The SHA-256 is of the zip published for
 * that revision; an install refuses a download that does not match.
 */
export interface ChromiumBuild {
  /** Platform id used in the browser cache directory. */
  platform: string;
  revision: string;
  sha256: string;
  /** Directory on the snapshot host, for example Linux_x64. */
  archiveFolder: string;
  archiveName: string;
  /** Path of the executable inside the archive. */
  executable: string;
}

export const CHROMIUM_BUILDS: Record<string, ChromiumBuild> = {
  linux: {
    platform: "linux",
    revision: "1739944",
    sha256: "785f94df060d6714ef5dcd3f779af28debc2bda675efd3549800fcea1eb19f5c",
    archiveFolder: "Linux_x64",
    archiveName: "chrome-linux.zip",
    executable: "chrome-linux/chrome",
  },
  mac: {
    platform: "mac",
    revision: "1739926",
    sha256: "4fb86ae24c0ace4323c7c1c3ff034c225460d0ce800db8e5dbca06ff6852da17",
    archiveFolder: "Mac",
    archiveName: "chrome-mac.zip",
    executable: "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  },
  mac_arm: {
    platform: "mac_arm",
    revision: "1739942",
    sha256: "a25b1d5a72b6b57b186c2bf784b3fd99a1fc66241a6b542b50a47fb007c3c067",
    archiveFolder: "Mac_Arm",
    archiveName: "chrome-mac.zip",
    executable: "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  },
  win64: {
    platform: "win64",
    revision: "1739871",
    sha256: "1f64ba54679753406996d4f67de232fe9eb0f9ded142a172ed66791cdb37895e",
    archiveFolder: "Win_x64",
    archiveName: "chrome-win.zip",
    executable: "chrome-win/chrome.exe",
  },
  win32: {
    platform: "win32",
    revision: "1739824",
    sha256: "7d338979b6a0b4f422c7e3921d5c8db9575f94a1977b6840fdf82fd25c901dd6",
    archiveFolder: "Win",
    archiveName: "chrome-win.zip",
    executable: "chrome-win/chrome.exe",
  },
};

export function chromiumPlatformId(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform === "linux" && arch === "x64") return "linux";
  if (platform === "darwin" && arch === "arm64") return "mac_arm";
  if (platform === "darwin" && arch === "x64") return "mac";
  if (platform === "win32" && arch === "x64") return "win64";
  if (platform === "win32" && arch === "ia32") return "win32";
  return undefined;
}

export function chromiumBuildFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ChromiumBuild {
  const id = chromiumPlatformId(platform, arch);
  const build = id ? CHROMIUM_BUILDS[id] : undefined;
  if (!build) {
    throw new Error(
      `No pinned Chromium download for ${platform} ${arch}. Refusing to download an unverified browser.`,
    );
  }
  return build;
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function assertSha256(data: Buffer, expected: string): void {
  const actual = sha256Hex(data);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      "Chromium download checksum did not match the pinned build",
    );
  }
}

/** Check the archive, then unpack it. A mismatch unpacks nothing. */
export function unpackVerifiedZip(
  data: Buffer,
  expectedSha256: string,
  dest: string,
): void {
  assertSha256(data, expectedSha256);
  unzipSafe(data, dest);
}

/** Unpack a zip, rejecting names that escape `dest`. */
export function unzipSafe(data: Buffer, dest: string): void {
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  let offset = 0;
  while (offset + 30 <= data.length) {
    const signature = data.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) {
      throw new Error("Chromium archive is not a zip file");
    }
    const flags = data.readUInt16LE(offset + 6);
    const method = data.readUInt16LE(offset + 8);
    const compressedSize = data.readUInt32LE(offset + 18);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = data.toString("utf8", nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    if ((flags & 0x8) !== 0 && compressedSize === 0) {
      throw new Error("Chromium archive uses a data descriptor");
    }
    if (dataStart + compressedSize > data.length) {
      throw new Error("Chromium archive is truncated");
    }
    const payload = data.subarray(dataStart, dataStart + compressedSize);
    if (name && !name.endsWith("/")) {
      const outPath = safeJoin(root, name);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const content =
        method === 0 ? payload : method === 8 ? inflateRawSync(payload) : null;
      if (!content) throw new Error(`Unsupported zip method ${method}`);
      fs.writeFileSync(outPath, content);
    } else if (name.endsWith("/")) {
      fs.mkdirSync(safeJoin(root, name), { recursive: true });
    }
    offset = dataStart + compressedSize;
    if ((flags & 0x8) !== 0) {
      if (data.readUInt32LE(offset) === 0x08074b50) offset += 4;
      offset += 12;
    }
  }
}

function safeJoin(root: string, name: string): string {
  const outPath = path.resolve(root, name);
  if (outPath !== root && !outPath.startsWith(root + path.sep)) {
    throw new Error(
      "Chromium archive contains a path that escapes the destination",
    );
  }
  return outPath;
}

export function chromiumInstallDir(
  downloadPath: string,
  build: ChromiumBuild,
): string {
  return path.join(
    downloadPath,
    ".chromium-browser-snapshots",
    "chromium",
    `${build.platform}-${build.revision}`,
  );
}

/**
 * Download the pinned archive, check its SHA-256, and unpack it.
 * Returns the executable path. A previous verified copy is reused.
 */
export async function downloadVerifiedChromium(
  downloadPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const build = chromiumBuildFor();
  const installDir = chromiumInstallDir(downloadPath, build);
  const executable = path.join(installDir, build.executable);
  const stamp = path.join(installDir, ".sha256");
  if (
    fs.existsSync(executable) &&
    fs.existsSync(stamp) &&
    fs.readFileSync(stamp, "utf8").trim() === build.sha256
  ) {
    return executable;
  }

  const url = `https://storage.googleapis.com/chromium-browser-snapshots/${build.archiveFolder}/${build.revision}/${build.archiveName}`;
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) {
    throw new Error(`Chromium download failed (${response.status})`);
  }
  fs.mkdirSync(installDir, { recursive: true });
  // Buffer the archive before unpacking. The extension typecheck does not
  // include Node's Readable.fromWeb, and the checksum is checked on these bytes.
  const data = Buffer.from(await response.arrayBuffer());
  unpackVerifiedZip(data, build.sha256, installDir);
  if (!fs.existsSync(executable)) {
    throw new Error("Chromium archive did not contain the expected executable");
  }
  try {
    fs.chmodSync(executable, 0o755);
  } catch {
    // Windows does not use this bit.
  }
  fs.writeFileSync(stamp, build.sha256);
  return executable;
}
