import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { fetchwithRequestOptions } from "./fetch.js";

function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

describe("API key headers on redirect", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const server of servers) server.close();
    servers.length = 0;
  });

  test("a cross-origin redirect drops provider API key headers", async () => {
    const seen: Record<string, string | undefined> = {};
    const dest = await listen((req, res) => {
      seen.apiKey = req.headers["x-api-key"] as string | undefined;
      seen.goog = req.headers["x-goog-api-key"] as string | undefined;
      seen.azure = req.headers["api-key"] as string | undefined;
      seen.auth = req.headers.authorization;
      res.end("arrived");
    });
    servers.push(dest.server);
    const src = await listen((_req, res) => {
      res.writeHead(302, {
        location: `http://127.0.0.1:${dest.port}/landed`,
      });
      res.end();
    });
    servers.push(src.server);

    const resp = await fetchwithRequestOptions(
      `http://127.0.0.1:${src.port}/start`,
      {
        headers: {
          Authorization: "Bearer secret",
          "x-api-key": "provider-secret",
          "x-goog-api-key": "goog-secret",
          "api-key": "azure-secret",
        },
      },
    );
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("arrived");
    expect(seen.apiKey).toBeUndefined();
    expect(seen.goog).toBeUndefined();
    expect(seen.azure).toBeUndefined();
  });

  test("a same-origin redirect keeps provider API key headers", async () => {
    const seen: Record<string, string | undefined> = {};
    const server = await listen((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/landed" });
        res.end();
        return;
      }
      seen.apiKey = req.headers["x-api-key"] as string | undefined;
      res.end("arrived");
    });
    servers.push(server.server);

    const resp = await fetchwithRequestOptions(
      `http://127.0.0.1:${server.port}/start`,
      { headers: { "x-api-key": "provider-secret" } },
    );
    expect(await resp.text()).toBe("arrived");
    expect(seen.apiKey).toBe("provider-secret");
  });
});
