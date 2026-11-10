import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { startupEnv } from "../startupEnv.js";

import { constructStdioTransport } from "./mcpTransports.js";
import type { MCPConnectionInfo } from "./types.js";

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(function StdioClientTransport(this: {
    stderr: null;
  }) {
    this.stderr = null;
  }),
}));

describe("constructStdioTransport environment", () => {
  beforeEach(() => {
    vi.mocked(StdioClientTransport).mockClear();
  });

  it("does not pass control variables that appeared after process start", () => {
    const previous = {
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      BASH_ENV: process.env.BASH_ENV,
      LD_PRELOAD: process.env.LD_PRELOAD,
    };
    process.env.NODE_OPTIONS = "--require /tmp/hook.js";
    process.env.BASH_ENV = "/tmp/setup.sh";
    process.env.LD_PRELOAD = "/tmp/lib.so";
    try {
      constructStdioTransport(
        {
          name: "server",
          command: "node",
          args: ["server.js"],
          env: { EXPLICIT: "yes" },
        },
        { warnings: [] } as unknown as MCPConnectionInfo,
      );
      const options = vi.mocked(StdioClientTransport).mock.calls[0]?.[0] as {
        env?: Record<string, string>;
      };
      expect(options.env?.EXPLICIT).toBe("yes");
      expect(options.env?.NODE_OPTIONS).toBeUndefined();
      expect(options.env?.BASH_ENV).toBeUndefined();
      expect(options.env?.LD_PRELOAD).toBeUndefined();
      expect(options.env?.PATH).toBe(startupEnv.PATH);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
