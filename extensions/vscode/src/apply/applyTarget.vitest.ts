import { describe, expect, it } from "vitest";

import { documentChanged, editorMatchesFilepath } from "./applyTarget";

describe("documentChanged", () => {
  const captured = { uri: "file:///ws/a.ts", version: 3 };

  it("is unchanged for the same document and version", () => {
    expect(documentChanged(captured, captured)).toBe(false);
  });

  it("treats a different open document as a different target", () => {
    expect(
      documentChanged(captured, { uri: "file:///ws/b.ts", version: 3 }),
    ).toBe(true);
    expect(documentChanged(captured, undefined)).toBe(true);
  });

  it("treats a newer version as an edit that must not be overwritten", () => {
    expect(
      documentChanged(captured, { uri: "file:///ws/a.ts", version: 4 }),
    ).toBe(true);
  });
});

describe("editorMatchesFilepath", () => {
  const editor = { uri: "file:///ws/src/a.ts", fsPath: "/ws/src/a.ts" };

  it("matches the URI and the filesystem path", () => {
    expect(editorMatchesFilepath(editor, "file:///ws/src/a.ts")).toBe(true);
    expect(editorMatchesFilepath(editor, "/ws/src/a.ts")).toBe(true);
  });

  it("does not match a different file that merely ends with the same name", () => {
    expect(editorMatchesFilepath(editor, "file:///other/a.ts")).toBe(false);
    expect(editorMatchesFilepath(editor, "a.ts")).toBe(false);
  });
});
