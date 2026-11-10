import { deflateRawSync } from "node:zlib";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSha256,
  sha256Hex,
  unpackVerifiedZip,
  unzipSafe,
} from "./chromiumDownload";

function storedZip(name: string, content: Buffer): Buffer {
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBytes.length, 12);
  end.writeUInt32LE(30 + nameBytes.length + content.length, 16);
  return Buffer.concat([local, nameBytes, content, central, nameBytes, end]);
}

function deflatedZip(name: string, content: Buffer): Buffer {
  const payload = deflateRawSync(content);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(content.length, 22);
  return Buffer.concat([local, nameBytes, payload]);
}

describe("Chromium download checksum", () => {
  it("rejects an archive whose checksum does not match", () => {
    const zip = storedZip("chrome-linux/chrome", Buffer.from("browser"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-checksum-"));
    expect(() => unpackVerifiedZip(zip, "0".repeat(64), dir)).toThrow(
      /checksum/,
    );
    expect(fs.existsSync(path.join(dir, "chrome-linux", "chrome"))).toBe(false);
    expect(() => assertSha256(zip, sha256Hex(zip))).not.toThrow();
  });

  it("unpacks a matching archive and rejects a path that escapes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-unzip-"));
    const zip = deflatedZip("chrome-linux/chrome", Buffer.from("browser"));
    unzipSafe(zip, dir);
    expect(
      fs.readFileSync(path.join(dir, "chrome-linux", "chrome"), "utf8"),
    ).toBe("browser");
    const escape = storedZip("../outside", Buffer.from("nope"));
    expect(() => unzipSafe(escape, dir)).toThrow(/escapes/);
  });
});
