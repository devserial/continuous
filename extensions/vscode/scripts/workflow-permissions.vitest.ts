import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "../../..");

/** The workflow-level permissions block (column 0), not a job's block. */
function topLevelPermissions(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === "permissions:");
  if (start < 0) return null;
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (!/^\s/.test(lines[i])) break;
    block.push(lines[i].trim());
  }
  return block.join("\n");
}

const READ_ONLY = [
  ".github/workflows/cli-pr-checks.yml",
  ".github/workflows/main.yaml",
  ".github/workflows/preview.yaml",
  ".github/workflows/pr-checks.yaml",
  ".github/workflows/jetbrains-release.yaml",
];

describe("workflow permissions", () => {
  it.each(READ_ONLY)("%s defaults the token to contents: read", (file) => {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    expect(topLevelPermissions(text)).toBe("contents: read");
  });

  it("does not grant pull-requests or issues write to every CLI PR job", () => {
    const text = fs.readFileSync(
      path.join(root, ".github/workflows/cli-pr-checks.yml"),
      "utf8",
    );
    expect(text).not.toContain("pull-requests:");
    expect(text).not.toContain("issues:");
  });
});
