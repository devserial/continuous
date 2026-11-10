import { describe, expect, it } from "vitest";
import {
  isInsideWorkspace,
  openUrlFromWebviewOk,
  policySavePayloadOk,
  raisedPolicyAreas,
  runCommandFromWebviewOk,
  subprocessFromWebviewOk,
  writeFileFromWebviewOk,
} from "./webviewMessageGuard";

const WORKSPACE = ["file:///home/u/proj"];

describe("raisedPolicyAreas", () => {
  it("lists an area whose level goes up and ignores one that stays or drops", () => {
    expect(
      raisedPolicyAreas(
        { tools: "cautious", edits: "permissive", context: "permissive" },
        { tools: "permissive", edits: "manual", context: "permissive" },
      ),
    ).toEqual(["tools"]);
  });

  it("treats yolo as higher than permissive", () => {
    expect(
      raisedPolicyAreas({ tools: "permissive" }, { tools: "yolo" }),
    ).toEqual(["tools"]);
  });
});

describe("policySavePayloadOk", () => {
  it("accepts a known level and rejects an unknown one", () => {
    expect(policySavePayloadOk({ levels: { tools: "manual" } })).toBe(true);
    expect(policySavePayloadOk({ levels: { tools: "allow-all" } })).toBe(false);
    expect(policySavePayloadOk({ levels: { notAnArea: "manual" } })).toBe(
      false,
    );
    expect(policySavePayloadOk(null)).toBe(false);
    expect(policySavePayloadOk({ questions: { youDecide: ["scope"] } })).toBe(
      true,
    );
  });
});

describe("openUrlFromWebviewOk", () => {
  it("allows http(s) and mailto and rejects other schemes", () => {
    expect(openUrlFromWebviewOk("https://example.com/docs")).toBe(true);
    expect(openUrlFromWebviewOk("http://example.com")).toBe(true);
    expect(openUrlFromWebviewOk("mailto:dev@example.com")).toBe(true);
    expect(openUrlFromWebviewOk("file:///tmp/notes")).toBe(false);
    expect(openUrlFromWebviewOk("command:workbench.action.reloadWindow")).toBe(
      false,
    );
    expect(openUrlFromWebviewOk("javascript:alert(1)")).toBe(false);
  });
});

describe("runCommandFromWebviewOk", () => {
  it("requires a string command", () => {
    expect(runCommandFromWebviewOk({ command: "npm test" })).toBe(true);
    expect(runCommandFromWebviewOk({ command: 1 })).toBe(false);
    expect(runCommandFromWebviewOk("npm test")).toBe(false);
  });
});

describe("writeFileFromWebviewOk and isInsideWorkspace", () => {
  it("requires a path and contents", () => {
    expect(
      writeFileFromWebviewOk({
        path: "file:///home/u/proj/a.md",
        contents: "x",
      }),
    ).toBe(true);
    expect(writeFileFromWebviewOk({ path: "file:///home/u/proj/a.md" })).toBe(
      false,
    );
  });

  it("allows a file inside the workspace and rejects one outside or that climbs out", () => {
    expect(
      isInsideWorkspace("file:///home/u/proj/.continue/plans/a.md", WORKSPACE),
    ).toBe(true);
    expect(isInsideWorkspace("/home/u/proj/a.md", WORKSPACE)).toBe(true);
    expect(isInsideWorkspace("file:///home/u/.ssh/id_rsa", WORKSPACE)).toBe(
      false,
    );
    expect(
      isInsideWorkspace("file:///home/u/proj/../../.ssh/id_rsa", WORKSPACE),
    ).toBe(false);
    expect(isInsideWorkspace("file:///home/u/proj-evil/a.md", WORKSPACE)).toBe(
      false,
    );
  });
});

describe("subprocessFromWebviewOk", () => {
  it("requires a command and a workspace working directory", () => {
    expect(
      subprocessFromWebviewOk({ command: "npm test", cwd: "/home/u/proj" }),
    ).toBe(true);
    expect(subprocessFromWebviewOk({ command: "   " })).toBe(false);
    expect(subprocessFromWebviewOk({ command: "npm test", cwd: 1 })).toBe(
      false,
    );
    expect(isInsideWorkspace("/home/u/proj", WORKSPACE)).toBe(true);
    expect(isInsideWorkspace("/tmp", WORKSPACE)).toBe(false);
  });
});
