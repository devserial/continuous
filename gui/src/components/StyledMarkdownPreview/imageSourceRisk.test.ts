import { describe, expect, it } from "vitest";
import { imageSourceRisk } from "./imageSourceRisk";

describe("imageSourceRisk", () => {
  it("names a remote host even when the secret is only in the path", () => {
    const risk = imageSourceRisk("https://evil.example/leak/token.png");
    expect(risk.remoteHost).toBe("evil.example");
    expect(risk.hasQueryParams).toBe(false);
  });

  it("keeps query parameters for display", () => {
    const risk = imageSourceRisk("https://example.com/image.jpg?user=123");
    expect(risk.remoteHost).toBe("example.com");
    expect(risk.queryParams).toEqual({ user: "123" });
  });

  it("treats localhost, relative, data and file URLs as local", () => {
    expect(
      imageSourceRisk("https://localhost/a.png").remoteHost,
    ).toBeUndefined();
    expect(
      imageSourceRisk("http://127.0.0.1/a.png").remoteHost,
    ).toBeUndefined();
    expect(imageSourceRisk("/images/a.png").remoteHost).toBeUndefined();
    expect(
      imageSourceRisk("data:image/png;base64,aaaa").remoteHost,
    ).toBeUndefined();
    expect(imageSourceRisk("file:///tmp/a.png").remoteHost).toBeUndefined();
  });
});
