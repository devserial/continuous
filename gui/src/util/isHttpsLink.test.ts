import { describe, expect, it } from "vitest";
import { isHttpsLink } from "./isHttpsLink";

describe("isHttpsLink", () => {
  it("accepts https URLs with a host", () => {
    expect(isHttpsLink("https://example.com/docs")).toBe(true);
    expect(isHttpsLink("https://example.com")).toBe(true);
  });

  it("rejects other schemes and empty values", () => {
    expect(isHttpsLink("http://example.com")).toBe(false);
    expect(isHttpsLink("file:///tmp/tool")).toBe(false);
    expect(isHttpsLink("javascript:alert(1)")).toBe(false);
    expect(isHttpsLink("command:workbench.action.reloadWindow")).toBe(false);
    expect(isHttpsLink("vscode://file/tmp")).toBe(false);
    expect(isHttpsLink("")).toBe(false);
    expect(isHttpsLink(undefined)).toBe(false);
  });
});
