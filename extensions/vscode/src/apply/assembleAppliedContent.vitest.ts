import { describe, expect, it } from "vitest";

import { assembleAppliedContent } from "./assembleAppliedContent";

describe("assembleAppliedContent", () => {
  it("keeps the head and tail that a pruned prompt left out", () => {
    const full =
      "HEAD\n" + "line\n".repeat(5) + "SEL\n" + "tail\n".repeat(5) + "END";
    const start = full.indexOf("SEL");
    const end = start + "SEL\n".length;
    const fullPrefix = full.slice(0, start);
    const fullSuffix = full.slice(end);
    const promptPrefix = fullPrefix.split("\n").slice(-1).join("\n");
    const promptSuffix = fullSuffix.split("\n")[0] ?? "";

    const applied = assembleAppliedContent(fullPrefix, ["NEW"], fullSuffix);

    expect(applied.startsWith("HEAD\n")).toBe(true);
    expect(applied.endsWith("END")).toBe(true);
    expect(applied).toContain("line\nNEW");
    expect(applied).toContain("tail\n");
    expect(applied).not.toBe(`${promptPrefix}NEW${promptSuffix}`);
    expect(applied).not.toContain("SEL");
  });
});
