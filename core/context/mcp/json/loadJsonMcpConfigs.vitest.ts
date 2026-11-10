import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IDE } from "../../..";
import { walkDirCache } from "../../../indexing/walkDir";
import { getGlobalFolderWithName } from "../../../util/paths";
import { localPathToUri } from "../../../util/pathToUri";
import { joinPathsToUri } from "../../../util/uri";
import { loadJsonMcpConfigs } from "./loadJsonMcpConfigs";

const WORKSPACE = "file:///work/repo";
const WORKSPACE_MCP = "file:///work/repo/.continuous/mcpServers";

function ide(files: Record<string, string>, delayUri?: string): IDE {
  return {
    getWorkspaceDirs: async () => [WORKSPACE],
    fileExists: async (uri: string) =>
      Object.keys(files).some((file) => file.startsWith(uri)),
    listDir: async (uri: string) =>
      Object.keys(files)
        .filter((file) => file.startsWith(uri) && file !== uri)
        .map((file) => [path.basename(file), 1] as [string, number]),
    readFile: async (uri: string) => {
      if (uri === delayUri) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return files[uri];
    },
  } as unknown as IDE;
}

describe("loadJsonMcpConfigs", () => {
  afterEach(() => {
    delete process.env.CN_MCP_JSON_TEST_TOKEN;
    walkDirCache.invalidate();
  });

  it("keeps the user-global server when a folder file reuses the name, even if the global file is slower to read", async () => {
    const globalDir = localPathToUri(getGlobalFolderWithName("mcpServers"));
    fs.mkdirSync(getGlobalFolderWithName("mcpServers"), { recursive: true });
    const globalUri = joinPathsToUri(globalDir, "github.json");
    const workspaceUri = joinPathsToUri(WORKSPACE_MCP, "github.json");
    const files: Record<string, string> = {
      [globalUri]: JSON.stringify({
        mcpServers: { github: { command: "npx", args: ["user-server"] } },
      }),
      [workspaceUri]: JSON.stringify({
        mcpServers: {
          github: { command: "sh", args: ["-c", "echo"] },
          other: { command: "node" },
        },
      }),
    };
    const { mcpServers } = await loadJsonMcpConfigs(
      ide(files, globalUri),
      true,
    );
    const github = mcpServers.filter((server) => server.name === "github");
    expect(github).toHaveLength(1);
    expect("command" in github[0] && github[0].command).toBe("npx");
    expect(github[0].sourceFile).toBe(globalUri);
    expect(mcpServers.some((server) => server.name === "other")).toBe(true);
  });

  it("renders ${VAR} in a user MCP JSON file from the environment", async () => {
    const globalDir = localPathToUri(getGlobalFolderWithName("mcpServers"));
    const globalUri = joinPathsToUri(globalDir, "token.json");
    const name = "CN_MCP_JSON_TEST_TOKEN";
    process.env[name] = "token-from-env";
    const { mcpServers } = await loadJsonMcpConfigs(
      ide({
        [globalUri]: JSON.stringify({
          mcpServers: {
            token: { command: "npx", env: { TOKEN: `\${${name}}` } },
          },
        }),
      }),
      true,
    );
    const token = mcpServers.find((server) => server.name === "token");
    expect(token && "env" in token ? token.env?.TOKEN : undefined).toBe(
      "token-from-env",
    );
    delete process.env[name];
  });
});
