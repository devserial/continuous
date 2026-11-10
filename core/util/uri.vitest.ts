import { describe, expect, it } from "vitest";
import { findUriInDirs } from "./uri";

const dirs = ["file:///workspace/project1", "file:///workspace/project2"];

describe("findUriInDirs resolves the URI path before comparing", () => {
  it("does not treat dot segments as still inside the directory", () => {
    expect(
      findUriInDirs("file:///workspace/project1/../project2/file.ts", dirs),
    ).toMatchObject({
      foundInDir: "file:///workspace/project2",
      relativePathOrBasename: "file.ts",
    });
    expect(
      findUriInDirs("file:///workspace/project1/../other/secret.txt", dirs)
        .foundInDir,
    ).toBeNull();
  });

  it("percent-decodes before resolving dot segments", () => {
    expect(
      findUriInDirs("file:///workspace/project1/%2E%2E/project2/file.ts", dirs)
        .foundInDir,
    ).toBe("file:///workspace/project2");
    expect(
      findUriInDirs("file:///workspace/project1/%2e%2e/other/secret.txt", dirs)
        .foundInDir,
    ).toBeNull();
    expect(
      findUriInDirs("file:///workspace/project1/src/%2E%2E/file.ts", dirs),
    ).toMatchObject({
      foundInDir: "file:///workspace/project1",
      relativePathOrBasename: "file.ts",
    });
  });

  it("resolves dot segments in non-file URIs the same way", () => {
    const remote = ["vscode-remote://wsl/workspace/project1"];
    expect(
      findUriInDirs("vscode-remote://wsl/workspace/project1/../other/x", remote)
        .foundInDir,
    ).toBeNull();
    expect(
      findUriInDirs(
        "vscode-remote://wsl/workspace/project1/src/%2E%2E/file.ts",
        remote,
      ),
    ).toMatchObject({
      foundInDir: remote[0],
      relativePathOrBasename: "file.ts",
    });
  });
});
