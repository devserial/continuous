import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readFileTool } from "../../../tools/definitions/readFile";
import { BuiltInToolNames } from "../../../tools/builtIn";
import { retrievalToolAllowed } from "./retrievalPolicy";

describe("experimental retrieval policy", () => {
  it("runs an ordinary read and skips a protected path and a floor rule", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-retrieval-"));
    const file = path.join(dir, "permissions.yaml");
    fs.writeFileSync(file, "floor:\n  - readFile(secrets/**)\n");
    expect(
      retrievalToolAllowed(
        readFileTool,
        { filepath: "src/a.ts" },
        undefined,
        file,
      ),
    ).toBe(true);
    expect(
      retrievalToolAllowed(readFileTool, { filepath: ".env" }, undefined, file),
    ).toBe(false);
    expect(
      retrievalToolAllowed(
        readFileTool,
        { filepath: "secrets/key.txt" },
        undefined,
        file,
      ),
    ).toBe(false);
    expect(readFileTool.function.name).toBe(BuiltInToolNames.ReadFile);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
