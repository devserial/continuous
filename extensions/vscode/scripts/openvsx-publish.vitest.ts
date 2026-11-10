import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "../../..");

function jobBlock(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`missing job ${name}`);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-z0-9-]+:$/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

describe("Open VSX publish jobs", () => {
  it.each(["main.yaml", "preview.yaml"])(
    "%s waits for the marketplace environment and the repository guard",
    (file) => {
      const text = fs.readFileSync(
        path.join(root, ".github/workflows", file),
        "utf8",
      );
      const job = jobBlock(text, "publish-openvsx");
      expect(job).toMatch(/environment:\s*marketplace/);
      expect(job).toContain("github.repository == 'b1tninja/continuous'");
      expect(job).not.toContain("continue-on-error");
    },
  );
});
