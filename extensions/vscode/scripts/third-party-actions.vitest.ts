import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "../../..");

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...yamlFiles(full));
    else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Third-party `uses:` values that are not pinned to a commit SHA. */
export function unpinnedThirdPartyUses(text: string): string[] {
  const bad: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const uses = line.match(/uses:\s*(\S+)/);
    if (!uses) continue;
    const ref = uses[1];
    if (
      ref.startsWith("./") ||
      ref.startsWith("actions/") ||
      ref.startsWith("github/")
    ) {
      continue;
    }
    const sha = ref.slice(ref.lastIndexOf("@") + 1);
    if (!/^[0-9a-f]{40}$/.test(sha)) bad.push(ref);
  }
  return bad;
}

describe("third-party actions", () => {
  const files = [
    ...yamlFiles(path.join(root, ".github/workflows")),
    ...yamlFiles(path.join(root, ".github/actions")),
  ];

  it("pins every third-party action to a commit SHA", () => {
    const unpinned = files.flatMap((file) =>
      unpinnedThirdPartyUses(fs.readFileSync(file, "utf8")).map(
        (ref) => `${path.relative(root, file)}: ${ref}`,
      ),
    );
    expect(unpinned).toEqual([]);
  });

  it("treats a moving tag as unpinned and a SHA as pinned", () => {
    expect(unpinnedThirdPartyUses("uses: example/action@v1")).toEqual([
      "example/action@v1",
    ]);
    expect(
      unpinnedThirdPartyUses(
        "uses: example/action@0123456789abcdef0123456789abcdef01234567",
      ),
    ).toEqual([]);
    expect(unpinnedThirdPartyUses("uses: actions/checkout@v7")).toEqual([]);
    expect(unpinnedThirdPartyUses("  # uses: example/action@main")).toEqual([]);
  });
});
