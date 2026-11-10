import { describe, expect, it, vi } from "vitest";

const { update, inspect } = vi.hoisted(() => ({
  update: vi.fn(async (_key: string, _value: unknown, _target: number) => {}),
  inspect: vi.fn((_key: string) => ({
    globalValue: undefined as unknown,
    workspaceValue: undefined as unknown,
  })),
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    getConfiguration: () => ({ inspect, update }),
    workspaceFolders: [{ uri: { fsPath: "/repo" } }],
  },
}));

import {
  contributedSettingKeys,
  migrateContinueSettings,
} from "./migrateSettings";

const packageJSON = require("../../package.json");

describe("contributedSettingKeys", () => {
  it("lists the manifest's continuous.* settings", () => {
    const keys = contributedSettingKeys(packageJSON);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain("continuous.enableTabAutocomplete");
    expect(keys.every((key) => key.startsWith("continuous."))).toBe(true);
  });

  it("contributes no continue.* names any more", () => {
    const text = JSON.stringify(packageJSON.contributes);
    expect(text).not.toMatch(/"continue\.[A-Za-z]/);
    expect(text).not.toMatch(/config\.continue\./);
  });

  it("keeps the remote config URL and user token out of folder settings", () => {
    const properties = packageJSON.contributes.configuration.properties;
    expect(properties["continuous.remoteConfigServerUrl"].scope).toBe(
      "application",
    );
    expect(properties["continuous.userToken"].scope).toBe("application");
  });

  it("copies user settings only, not values from the folder", async () => {
    update.mockClear();
    inspect.mockImplementation((key: string) => ({
      globalValue: key === "continue.enableTabAutocomplete" ? true : undefined,
      workspaceValue:
        key === "continue.remoteConfigServerUrl"
          ? "https://example.test/config"
          : undefined,
    }));
    const workspaceState = { get: () => false, update: vi.fn() };
    await migrateContinueSettings({
      extension: { packageJSON },
      globalState: { get: () => false, update: vi.fn() },
      workspaceState,
    } as any);
    expect(update.mock.calls.every((call) => call[2] === 1)).toBe(true);
    expect(
      update.mock.calls.some(
        (call) => call[0] === "continuous.remoteConfigServerUrl",
      ),
    ).toBe(false);
    expect(workspaceState.update).not.toHaveBeenCalled();
  });

  it("reads one configuration section or a list of them", () => {
    expect(
      contributedSettingKeys({
        contributes: {
          configuration: [
            { properties: { "continuous.a": {} } },
            { properties: { "continuous.b": {}, "other.c": {} } },
          ],
        },
      }),
    ).toEqual(["continuous.a", "continuous.b"]);
    expect(contributedSettingKeys({})).toEqual([]);
  });
});
