import { describe, expect, it } from "vitest";
import { safeMarkdownHref } from "./safeMarkdownHref";

describe("safeMarkdownHref", () => {
  it("keeps http, https, mailto, fragments and relative paths", () => {
    expect(safeMarkdownHref("https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(safeMarkdownHref("HTTP://example.com")).toBe("HTTP://example.com");
    expect(safeMarkdownHref("mailto:dev@example.com")).toBe(
      "mailto:dev@example.com",
    );
    expect(safeMarkdownHref("#section")).toBe("#section");
    expect(safeMarkdownHref("/docs/page")).toBe("/docs/page");
    expect(safeMarkdownHref("./local.md")).toBe("./local.md");
  });

  it("drops command, javascript, file, vscode and data links", () => {
    expect(
      safeMarkdownHref("command:workbench.action.reloadWindow"),
    ).toBeUndefined();
    expect(safeMarkdownHref("javascript:alert(1)")).toBeUndefined();
    expect(safeMarkdownHref("file:///tmp/notes.txt")).toBeUndefined();
    expect(safeMarkdownHref("vscode://file/tmp/notes.txt")).toBeUndefined();
    expect(safeMarkdownHref("data:text/html,hi")).toBeUndefined();
    expect(safeMarkdownHref("//example.com/path")).toBeUndefined();
  });

  it("drops empty values", () => {
    expect(safeMarkdownHref(undefined)).toBeUndefined();
    expect(safeMarkdownHref(null)).toBeUndefined();
    expect(safeMarkdownHref("   ")).toBeUndefined();
  });
});
