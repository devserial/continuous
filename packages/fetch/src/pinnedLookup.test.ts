import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { fetchwithRequestOptions } from "./fetch.js";

describe("pinned lookup", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const server of servers) server.close();
    servers.length = 0;
  });

  test("connects to the pinned address instead of resolving the name", async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;

    const resp = await fetchwithRequestOptions(
      `http://pinned.invalid:${port}/checked`,
      {
        lookup: (
          _hostname: string,
          options: unknown,
          callback?: (
            err: NodeJS.ErrnoException | null,
            address: string | { address: string; family: number }[],
            family?: number,
          ) => void,
        ) => {
          const cb =
            typeof options === "function"
              ? (options as typeof callback)
              : callback;
          const all =
            typeof options === "object" &&
            options !== null &&
            "all" in options &&
            Boolean((options as { all?: boolean }).all);
          if (all) cb?.(null, [{ address: "127.0.0.1", family: 4 }]);
          else cb?.(null, "127.0.0.1", 4);
        },
      } as never,
    );
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
    expect(hits).toEqual(["/checked"]);
  });
});
