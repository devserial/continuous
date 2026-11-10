import { afterEach, describe, expect, it } from "vitest";

import { remoteRequestInit } from "./useChat.remote.helpers.js";

describe("remote serve requests", () => {
  const previous = process.env.CONTINUOUS_SERVE_TOKEN;

  afterEach(() => {
    if (previous === undefined) delete process.env.CONTINUOUS_SERVE_TOKEN;
    else process.env.CONTINUOUS_SERVE_TOKEN = previous;
  });

  it("leaves the request unchanged when no token is set", () => {
    delete process.env.CONTINUOUS_SERVE_TOKEN;
    const init = { method: "POST" };
    expect(remoteRequestInit(init)).toBe(init);
    expect(remoteRequestInit()).toBeUndefined();
  });

  it("sends the bearer token and keeps the other headers", () => {
    process.env.CONTINUOUS_SERVE_TOKEN = "  serve-token-0123456789  ";
    expect(
      remoteRequestInit({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    ).toEqual({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer serve-token-0123456789",
      },
    });
  });
});
