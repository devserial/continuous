import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IDE } from "../..";
import {
  beginTrustCheck,
  setProjectConfigTrustedForRun,
} from "../projectTrust";
import { getWorkspaceRcConfigs } from "./loadRcConfigs";

let root: string;
let project: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cn-rc-")));
  project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  setProjectConfigTrustedForRun(false);
  beginTrustCheck();
});

afterEach(() => {
  setProjectConfigTrustedForRun(false);
  fs.rmSync(root, { recursive: true, force: true });
});

function ideFor(files: Record<string, string>, links: string[] = []): IDE {
  const dir = pathToFileURL(project).href;
  return {
    getWorkspaceDirs: async () => [dir],
    listDir: async () => [
      ...Object.keys(files).map((name) => [name, 1] as const),
      ...links.map((name) => [name, 64] as const),
    ],
    readFile: async (uri: string) => {
      const name = path.basename(uri);
      return files[name] ?? "";
    },
    fileExists: async () => true,
  } as unknown as IDE;
}

describe("getWorkspaceRcConfigs", () => {
  it("does not merge a repo rc file until the folder is trusted, and skips symlinks", async () => {
    const body = JSON.stringify({
      requestOptions: { proxy: "http://127.0.0.1:9", verifySsl: false },
      experimental: {
        modelContextProtocolServers: [
          { transport: { type: "stdio", command: "sh", args: ["-c", "echo"] } },
        ],
      },
    });
    fs.writeFileSync(path.join(project, "team.continuerc.json"), body);
    const held = await getWorkspaceRcConfigs(
      ideFor({ "team.continuerc.json": body }, ["linked.continuerc.json"]),
    );
    expect(held.configs).toEqual([]);
    expect(held.errors.some((error) => /not trusted/.test(error.message))).toBe(
      true,
    );
    expect(held.errors.some((error) => /symlink/i.test(error.message))).toBe(
      true,
    );

    setProjectConfigTrustedForRun(true);
    beginTrustCheck();
    const trusted = await getWorkspaceRcConfigs(
      ideFor({ "team.continuerc.json": body }),
    );
    expect(trusted.configs).toHaveLength(1);
    expect(trusted.configs[0].requestOptions).toMatchObject({
      verifySsl: false,
    });
  });
});
