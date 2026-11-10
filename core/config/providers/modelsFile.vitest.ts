import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseModelsFile } from "./modelsFile";

describe("parseModelsFile", () => {
  it("reads catalog models with variants", () => {
    const { models, errors } = parseModelsFile(
      `models:
  - name: Qwen3.8 Flash
    connection: strata
    model: qwen3.8-flash-next-nvfp4-nvfp4
    contextLength: 524288
    variants:
      plan:
        requestOptions:
          extraBodyProperties: { reasoning_effort: xhigh }
  - name: Claude Sonnet
    model: claude-sonnet-4-6
    routes:
      - connection: bedrock-us
        model: us.anthropic.claude-sonnet-4-6
`,
      "models.yaml",
    );
    expect(errors).toEqual([]);
    expect(models.map((m) => m.name)).toEqual([
      "Qwen3.8 Flash",
      "Claude Sonnet",
    ]);
    expect(models[0].variants?.plan).toBeDefined();
    expect(models[1].routes?.[0].connection).toBe("bedrock-us");
  });

  it("treats an empty file as no models", () => {
    expect(parseModelsFile("\n", "m.yaml")).toEqual({ models: [], errors: [] });
  });

  it("keeps the first of two models with the same name", () => {
    const { models, errors } = parseModelsFile(
      "models:\n  - { name: a, model: x }\n  - { name: a, model: y }\n",
      "m.yaml",
    );
    expect(models.map((m) => m.model)).toEqual(["x"]);
    expect(errors[0].message).toMatch(/defines the model "a" twice/);
  });

  it("skips a name with #, which would read as a variant", () => {
    const { models, errors } = parseModelsFile(
      "models:\n  - { name: 'a#b', model: x }\n",
      "m.yaml",
    );
    expect(models).toEqual([]);
    expect(errors[0].message).toMatch(/contains "#"/);
  });

  it("reports a model without its id", () => {
    const { errors } = parseModelsFile("models:\n  - { name: a }\n", "m.yaml");
    expect(errors[0].message).toMatch(/m\.yaml is not valid: models\.0\.model/);
  });
});

describe("loadModelCatalog", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-"));
    vi.resetModules();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.doUnmock("../../util/paths");
  });

  it("keeps a user's catalog model when a folder reuses the name, and ignores the folder until it is trusted", async () => {
    fs.writeFileSync(
      path.join(dir, "models.yaml"),
      "models:\n  - { name: a, model: global-a }\n  - { name: b, model: global-b }\n",
    );
    vi.doMock("../../util/paths", async () => {
      const actual =
        await vi.importActual<typeof import("../../util/paths")>(
          "../../util/paths",
        );
      return { ...actual, getContinueGlobalPath: () => dir };
    });
    const { loadModelCatalog } = await import("./modelsFile");
    const { setProjectConfigTrustedForRun } = await import("../projectTrust");
    const ide = {
      getWorkspaceDirs: async () => ["file:///ws"],
      fileExists: async (uri: string) =>
        uri === "file:///ws/.continuous/models.yaml",
      readFile: async () =>
        "models:\n  - { name: a, model: workspace-a, apiBase: https://example.test/v1/ }\n  - { name: extra, model: workspace-extra }\n",
    };
    const untrusted = await loadModelCatalog(ide as any);
    expect(untrusted.models.map((m) => [m.name, m.model])).toEqual([
      ["a", "global-a"],
      ["b", "global-b"],
    ]);
    expect(
      untrusted.errors.some((error) => /not trusted/.test(error.message)),
    ).toBe(true);

    setProjectConfigTrustedForRun(true);
    const trusted = await loadModelCatalog(ide as any);
    expect(trusted.models.map((m) => [m.name, m.model])).toEqual([
      ["a", "global-a"],
      ["b", "global-b"],
      ["extra", "workspace-extra"],
    ]);
    setProjectConfigTrustedForRun(false);
  });

  it("adds models and accounts from the IDE, which the files override", async () => {
    fs.writeFileSync(
      path.join(dir, "models.yaml"),
      "models:\n  - { name: a, model: file-a }\n",
    );
    fs.writeFileSync(
      path.join(dir, "providers.yaml"),
      "providers:\n  - { name: work, provider: openai, apiBase: https://file/ }\n",
    );
    vi.doMock("../../util/paths", async () => {
      const actual =
        await vi.importActual<typeof import("../../util/paths")>(
          "../../util/paths",
        );
      return { ...actual, getContinueGlobalPath: () => dir };
    });
    const { setExternalAccount } = await import("./externalAccounts");
    setExternalAccount("work", {
      account: { name: "work", provider: "openai", apiKey: "sk-vscode" },
      models: [
        { name: "a", model: "vscode-a", connection: "work" },
        { name: "b", model: "vscode-b", connection: "work" },
      ],
    });
    setExternalAccount("other", {
      account: { name: "other", provider: "anthropic", apiKey: "sk-a" },
      models: [],
    });
    const { loadModelCatalog } = await import("./modelsFile");
    const { loadProviderInstances } = await import("./providersFile");
    const ide = {
      getWorkspaceDirs: async () => [],
      fileExists: async () => false,
      readFile: async () => "",
    };
    const { models } = await loadModelCatalog(ide as any);
    expect(models.map((m) => [m.name, m.model])).toEqual([
      ["a", "file-a"],
      ["b", "vscode-b"],
    ]);
    const { providers } = await loadProviderInstances(ide as any);
    expect(providers.map((p) => [p.name, p.apiBase ?? p.apiKey])).toEqual([
      ["work", "https://file/"],
      ["other", "sk-a"],
    ]);
    expect(setExternalAccount("other", undefined)).toBe(true);
    expect(setExternalAccount("other", undefined)).toBe(false);
  });
});
