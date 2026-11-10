import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

describe("project and global env files", () => {
  const originalCwd = process.cwd();
  const original = {
    CONTINUE_GLOBAL_DIR: process.env.CONTINUE_GLOBAL_DIR,
    CONTINUOUS_GLOBAL_DIR: process.env.CONTINUOUS_GLOBAL_DIR,
    CONTINUE_API_BASE: process.env.CONTINUE_API_BASE,
    BASH_ENV: process.env.BASH_ENV,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    FROM_PROJECT: process.env.FROM_PROJECT,
    FROM_GLOBAL: process.env.FROM_GLOBAL,
    GLOBAL_ONLY_SECRET: process.env.GLOBAL_ONLY_SECRET,
  };

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("does not load a working-directory .env, and still reads the global file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cn-proj-env-"));
    const project = path.join(root, "project");
    const globalDir = path.join(root, "global");
    fs.mkdirSync(project);
    fs.mkdirSync(globalDir);
    fs.writeFileSync(
      path.join(project, ".env"),
      [
        "FROM_PROJECT=injected",
        "BASH_ENV=./setup.sh",
        "NODE_OPTIONS=--require ./hook.js",
        "CONTINUE_API_BASE=https://project.example/",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(globalDir, ".env"),
      [
        "FROM_GLOBAL=from-global-file",
        "BASH_ENV=./global-setup.sh",
        "NODE_OPTIONS=--require ./global-hook.js",
        "CONTINUE_API_BASE=https://global.example/",
        "GLOBAL_ONLY_SECRET=from-global-file",
      ].join("\n"),
    );

    delete process.env.CONTINUE_API_BASE;
    delete process.env.BASH_ENV;
    delete process.env.NODE_OPTIONS;
    delete process.env.FROM_PROJECT;
    delete process.env.FROM_GLOBAL;
    delete process.env.GLOBAL_ONLY_SECRET;
    delete process.env.CONTINUOUS_GLOBAL_DIR;
    process.env.CONTINUE_GLOBAL_DIR = globalDir;
    process.env.CONTINUOUS_IGNORE_CWD_ENV = "1";
    process.chdir(project);
    vi.resetModules();

    const { env } = await import("./env.js");
    const { CLIPlatformClient } = await import("./CLIPlatformClient.js");

    expect(process.env.FROM_PROJECT).toBeUndefined();
    expect(process.env.FROM_GLOBAL).toBeUndefined();
    expect(process.env.BASH_ENV).toBeUndefined();
    expect(process.env.NODE_OPTIONS).toBeUndefined();
    expect(process.env.CONTINUE_API_BASE).toBeUndefined();
    expect(env.apiBase).toBe("https://global.example/");
    expect(env.continueHome).toBe(globalDir);

    const client = new CLIPlatformClient(null, {
      syncSecrets: async () => {
        throw new Error("global file should have supplied the secret");
      },
    } as never);
    const [secret] = await client.resolveFQSNs([
      { packageSlugs: [], secretName: "GLOBAL_ONLY_SECRET" },
    ]);
    expect(secret).toMatchObject({
      found: true,
      value: "from-global-file",
    });

    await import("./stream/streamChatResponse.js");
    expect(process.env.FROM_PROJECT).toBeUndefined();
    expect(process.env.BASH_ENV).toBeUndefined();
    expect(process.env.NODE_OPTIONS).toBeUndefined();

    fs.rmSync(root, { recursive: true, force: true });
  });
});
