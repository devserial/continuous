import { describe, expect, it } from "vitest";

import { InternalMcpOptions } from "../..";
import {
  gateWorkspaceMcpServers,
  heldMcpServersFromBlock,
  oauthScopeForMcpServer,
  redactUntrustedMcpServer,
} from "./workspaceMcpPolicy";

const workspace = "file:///work/repo";

function server(
  name: string,
  sourceFile: string | undefined,
  command = "npx",
): InternalMcpOptions {
  return {
    id: name,
    name,
    command,
    args: ["server"],
    env: { TOKEN: "super-secret-value" },
    sourceFile,
  };
}

describe("oauthScopeForMcpServer", () => {
  const workspace = "file:///work/repo";
  const folderServer = {
    id: "linear",
    name: "linear",
    url: "https://mcp.example.com/mcp",
    sourceFile: "file:///work/repo/.continuous/mcpServers/linear.json",
    configSource: "workspace" as const,
  };

  it("keeps a folder server on its own sign-in, and does not use one when it sets a proxy", () => {
    expect(oauthScopeForMcpServer(folderServer, [workspace])).toEqual({
      scope: "workspace",
      sendStoredToken: true,
    });
    expect(
      oauthScopeForMcpServer(
        {
          ...folderServer,
          requestOptions: { proxy: "http://127.0.0.1:9", verifySsl: false },
        },
        [workspace],
      ).sendStoredToken,
    ).toBe(false);
    expect(
      oauthScopeForMcpServer(
        {
          id: "linear",
          name: "linear",
          url: "https://mcp.example.com/mcp",
          sourceFile: "file:///home/me/.continuous/mcpServers/linear.json",
          configSource: "user",
        },
        [workspace],
      ),
    ).toEqual({ sendStoredToken: true });
  });
});

describe("gateWorkspaceMcpServers", () => {
  it("holds a folder server and drops secret values until that folder is trusted", () => {
    const gated = gateWorkspaceMcpServers(
      [server("lint", "file:///work/repo/.continuous/mcpServers/lint.yaml")],
      [workspace],
      () => false,
    );
    expect(gated.servers).toHaveLength(1);
    const held = gated.servers[0];
    expect(held.projectTrust).toBe("required");
    expect(held.configSource).toBe("workspace");
    expect("env" in held && held.env).toEqual({ TOKEN: "" });
    expect(JSON.stringify(held)).not.toContain("super-secret-value");
    expect(
      gated.notices.some((notice) => notice.message.includes("not trusted")),
    ).toBe(true);
  });

  it("keeps the user's server when a folder file reuses its name", () => {
    const gated = gateWorkspaceMcpServers(
      [
        server(
          "github",
          "file:///home/me/.continuous/mcpServers/github.json",
          "npx",
        ),
        server(
          "github",
          "file:///work/repo/.continuous/mcpServers/github.json",
          "sh",
        ),
      ],
      [workspace],
      () => true,
    );
    expect(gated.servers).toEqual([
      expect.objectContaining({
        name: "github",
        command: "npx",
        configSource: "user",
      }),
    ]);
    expect(gated.notices[0].message).toMatch(/Kept your MCP server "github"/);
  });

  it("starts a folder server that does not reuse a name once the folder is trusted", () => {
    const gated = gateWorkspaceMcpServers(
      [server("lint", "file:///work/repo/.continue/mcpServers/lint.json")],
      [workspace],
      () => true,
    );
    expect(gated.servers[0].projectTrust).toBeUndefined();
    expect(gated.servers[0].configSource).toBe("workspace");
    expect("env" in gated.servers[0] && gated.servers[0].env?.TOKEN).toBe(
      "super-secret-value",
    );
  });

  it("builds a held server from a block without copying env values", () => {
    const [held] = heldMcpServersFromBlock(
      "file:///work/repo/.continuous/mcpServers/lint.yaml",
      `mcpServers:
  - name: lint
    command: sh
    args: ["-c", "echo"]
    env:
      TOKEN: super-secret-value
`,
    );
    expect(held.projectTrust).toBe("required");
    expect("command" in held && held.command).toBe("sh");
    expect("env" in held && held.env).toEqual({ TOKEN: "" });
    expect(JSON.stringify(redactUntrustedMcpServer(held))).not.toContain(
      "super-secret-value",
    );
  });
});
