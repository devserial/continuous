import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseProvidersFile } from "./providersFile";

describe("parseProvidersFile", () => {
  it("reads named instances", () => {
    const { providers, errors } = parseProvidersFile(
      `providers:
  - name: anthropic-work
    provider: anthropic
    apiKey: \${{ secrets.CONTINUOUS_ANTHROPIC_WORK_API_KEY }}
  - name: local
    provider: ollama
    apiBase: http://localhost:11434/
`,
      "providers.yaml",
    );
    expect(errors).toEqual([]);
    expect(providers.map((p) => [p.name, p.provider])).toEqual([
      ["anthropic-work", "anthropic"],
      ["local", "ollama"],
    ]);
  });

  it("treats an empty file as no instances", () => {
    expect(parseProvidersFile("  \n", "p.yaml")).toEqual({
      providers: [],
      errors: [],
    });
  });

  it("reports an instance without a provider", () => {
    const { providers, errors } = parseProvidersFile(
      "providers:\n  - name: x\n",
      "p.yaml",
    );
    expect(providers).toEqual([]);
    expect(errors[0].message).toMatch(
      /p\.yaml is not valid: providers\.0\.provider/,
    );
  });

  it("keeps the first of two instances with the same name", () => {
    const { providers, errors } = parseProvidersFile(
      `providers:
  - { name: a, provider: openai }
  - { name: a, provider: anthropic }
`,
      "p.yaml",
    );
    expect(providers).toEqual([{ name: "a", provider: "openai" }]);
    expect(errors[0].message).toMatch(/defines the provider "a" twice/);
  });

  it("reports unparseable YAML", () => {
    const { errors } = parseProvidersFile("providers: [", "p.yaml");
    expect(errors[0].message).toMatch(/Could not read p\.yaml/);
  });
});

describe("loadProviderInstances", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-"));
    vi.resetModules();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.doUnmock("../../util/paths");
  });

  it("keeps a user's provider when a folder reuses the name, and ignores the folder until it is trusted", async () => {
    fs.writeFileSync(
      path.join(dir, "providers.yaml"),
      "providers:\n  - { name: a, provider: openai }\n  - { name: b, provider: groq }\n",
    );
    vi.doMock("../../util/paths", async () => {
      const actual =
        await vi.importActual<typeof import("../../util/paths")>(
          "../../util/paths",
        );
      return { ...actual, getContinueGlobalPath: () => dir };
    });
    const { loadProviderInstances } = await import("./providersFile");
    const { setProjectConfigTrustedForRun } = await import("../projectTrust");
    const ide = {
      getWorkspaceDirs: async () => ["file:///ws"],
      fileExists: async (uri: string) =>
        uri === "file:///ws/.continuous/providers.yaml",
      readFile: async () =>
        "providers:\n  - { name: a, provider: anthropic, apiBase: https://example.test/v1/ }\n  - { name: extra, provider: openai }\n",
    };
    const untrusted = await loadProviderInstances(ide as any);
    expect(untrusted.providers).toEqual([
      { name: "a", provider: "openai" },
      { name: "b", provider: "groq" },
    ]);
    expect(
      untrusted.errors.some((error) => /not trusted/.test(error.message)),
    ).toBe(true);

    setProjectConfigTrustedForRun(true);
    const trusted = await loadProviderInstances(ide as any);
    expect(trusted.providers).toEqual([
      { name: "a", provider: "openai" },
      { name: "b", provider: "groq" },
      { name: "extra", provider: "openai" },
    ]);
    expect(
      trusted.errors.some((error) =>
        /Kept your provider "a"/.test(error.message),
      ),
    ).toBe(true);
    setProjectConfigTrustedForRun(false);
  });
});
