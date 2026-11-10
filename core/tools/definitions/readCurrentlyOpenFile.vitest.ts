import { describe, expect, it } from "vitest";
import type { IDE } from "../..";
import { evaluateToolPolicyWithRules } from "../permissions/evaluate";
import { findProtected } from "../permissions/protectedCall";
import { uriToPath } from "../permissions/names";
import { readCurrentlyOpenFileTool } from "./readCurrentlyOpenFile";

function ideWith(current: string | undefined, workspace: string): IDE {
  return {
    getCurrentFile: async () =>
      current
        ? { isUntitled: false, path: current, contents: "SECRET=1" }
        : undefined,
    getWorkspaceDirs: async () => [workspace],
    fileExists: async () => true,
  } as unknown as IDE;
}

describe("read_currently_open_file", () => {
  it("checks the open file against protected paths and path rules", async () => {
    const workspace = "file:///home/u/proj";
    const open = "file:///home/u/proj/.env";
    const processed = await readCurrentlyOpenFileTool.preprocessArgs!(
      {},
      { ide: ideWith(open, workspace) },
    );
    const resolved = processed.resolvedPath as { uri: string };
    expect(uriToPath(resolved.uri)).toBe("/home/u/proj/.env");
    expect(
      findProtected({
        toolName: "read_currently_open_file",
        parsedArgs: {},
        resolvedPath: uriToPath(resolved.uri),
        home: "/home/u",
      })?.kind,
    ).toBe("secret");

    const asked = evaluateToolPolicyWithRules({
      tool: readCurrentlyOpenFileTool,
      toolName: "read_currently_open_file",
      basePolicy: "allowedWithoutPermission",
      parsedArgs: {},
      processedArgs: processed,
      permissions: undefined,
    });
    expect(asked).toMatchObject({
      policy: "allowedWithPermission",
      source: "protected-path",
    });

    const denied = evaluateToolPolicyWithRules({
      tool: readCurrentlyOpenFileTool,
      toolName: "read_currently_open_file",
      basePolicy: "allowedWithoutPermission",
      parsedArgs: {},
      processedArgs: processed,
      permissions: { deny: ["readFile(**/.env)"] },
    });
    expect(denied).toMatchObject({ policy: "disabled", source: "deny-rule" });
  });

  it("has nothing to check when no file is open", async () => {
    const processed = await readCurrentlyOpenFileTool.preprocessArgs!(
      {},
      { ide: ideWith(undefined, "file:///home/u/proj") },
    );
    expect(processed.resolvedPath).toBeNull();
    expect(
      findProtected({
        toolName: "read_currently_open_file",
        parsedArgs: {},
        home: "/home/u",
      }),
    ).toBeUndefined();
  });
});
