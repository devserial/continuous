import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchwithRequestOptions } from "./fetch.js";
import { redactBody, redactHeaderValue, redactUrl } from "./redact.js";

describe("redactUrl", () => {
  test("blanks credential query parameters and leaves the rest", () => {
    const redacted = redactUrl(
      "https://aiplatform.googleapis.com/v1/models:stream?key=AIzaSecret&alt=sse",
    );
    expect(redacted).not.toContain("AIzaSecret");
    expect(redacted).toContain("key=REDACTED");
    expect(redacted).toContain("alt=sse");
    expect(
      redactUrl(
        "https://iam.example/token?apikey=super-secret&grant_type=apikey",
      ),
    ).not.toContain("super-secret");
  });

  test("masks credential headers", () => {
    expect(redactHeaderValue("x-api-key", "secret")).toBe("REDACTED");
    expect(redactHeaderValue("Authorization", "Bearer secret")).toBe(
      "REDACTED",
    );
    expect(redactHeaderValue("x-goog-api-key", "secret")).toBe("REDACTED");
    expect(redactHeaderValue("Content-Type", "application/json")).toBe(
      "application/json",
    );
    expect(redactBody("apikey=super-secret&grant_type=apikey")).not.toContain(
      "super-secret",
    );
  });
});

describe("VERBOSE_FETCH", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    delete process.env.VERBOSE_FETCH;
    for (const server of servers) server.close();
    servers.length = 0;
    vi.restoreAllMocks();
  });

  test("the curl log does not contain the key or credential headers", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    process.env.VERBOSE_FETCH = "1";
    const secret = "verbose-fetch-secret";
    await fetchwithRequestOptions(
      `http://127.0.0.1:${port}/v1?key=${secret}&alt=sse`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "x-api-key": secret,
          "x-goog-api-key": secret,
        },
        body: `apikey=${secret}&grant_type=apikey`,
      },
    );
    const log = lines.join("\n");
    expect(log).not.toContain(secret);
    expect(log).toContain("REDACTED");
    expect(log).toContain("Equivalent curl:");
  });
});
