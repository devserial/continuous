import { describe, expect, it } from "vitest";
import { getCommandExecutor } from "./commandExecutor";
import {
  parseLxss,
  readWslDistros,
  resetWslStatusCache,
  wslStatus,
  wslUnavailableMessage,
  WSL_INSTALL_COMMAND,
} from "./wslStatus";

const KEY =
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
const DISTROS = [
  `${KEY}\\{d607ab7d-6d95-4efe-9869-8ca6514c2de5}`,
  "    DistributionName    REG_SZ    docker-desktop",
  "",
  `${KEY}\\{fdaa1f03-71bd-49a0-b13d-fa2cf12b6bb5}`,
  "    DistributionName    REG_SZ    Ubuntu-22.04",
  "",
  "End of search: 2 match(es) found.",
  "",
].join("\r\n");
const DEFAULT = [
  KEY,
  "    DefaultDistribution    REG_SZ    {FDAA1F03-71BD-49A0-B13D-FA2CF12B6BB5}",
  "",
].join("\r\n");

describe("parseLxss", () => {
  it("lists the distributions, marks the default by its GUID, and drops Docker's own", () => {
    expect(parseLxss(DISTROS, DEFAULT)).toEqual([
      { name: "Ubuntu-22.04", isDefault: true },
    ]);
  });

  it("reads a name with spaces, and no default", () => {
    const out = `${KEY}\\{aaaa}\r\n    DistributionName    REG_SZ    My Distro\r\n`;
    expect(parseLxss(out, "")).toEqual([
      { name: "My Distro", isDefault: false },
    ]);
  });

  it("is empty when nothing is registered", () => {
    expect(parseLxss("", "")).toEqual([]);
    expect(
      parseLxss(
        "ERROR: The system was unable to find the specified registry key",
        "",
      ),
    ).toEqual([]);
  });
});

describe("wslStatus", () => {
  const ubuntu = [{ name: "Ubuntu", isDefault: true }];

  it("is not offered off Windows", () => {
    expect(wslStatus(undefined, { platform: "darwin" })).toEqual({
      state: "not-windows",
    });
    expect(wslStatus(undefined, { platform: "linux" }).state).toBe(
      "not-windows",
    );
  });

  it("has no distribution when none is registered", () => {
    expect(wslStatus(undefined, { platform: "win32", distros: [] })).toEqual({
      state: "no-distribution",
    });
  });

  it("is ready with a distribution, and checks a named one without regard to case", () => {
    expect(
      wslStatus(undefined, { platform: "win32", distros: ubuntu }).state,
    ).toBe("ready");
    expect(
      wslStatus("ubuntu", { platform: "win32", distros: ubuntu }).state,
    ).toBe("ready");
    expect(wslStatus("Debian", { platform: "win32", distros: ubuntu })).toEqual(
      {
        state: "distro-missing",
        wanted: "Debian",
        available: ["Ubuntu"],
      },
    );
  });
});

describe("wslUnavailableMessage", () => {
  it("says nothing when it is ready", () => {
    expect(
      wslUnavailableMessage({ state: "ready", distros: [] }),
    ).toBeUndefined();
  });

  it("tells a person with no distribution how to get WSL", () => {
    const text = wslUnavailableMessage({ state: "no-distribution" })!;
    expect(text).toContain(`\`${WSL_INSTALL_COMMAND}\``);
    expect(text).toContain("administrator");
    expect(text).toContain("restart");
    expect(text).toContain("wsl --list --online");
    expect(text).toContain("continuous.terminal.shell");
  });

  it("names the distribution that is missing and what is installed", () => {
    const text = wslUnavailableMessage({
      state: "distro-missing",
      wanted: "Debian",
      available: ["Ubuntu", "Arch"],
    })!;
    expect(text).toContain('"Debian"');
    expect(text).toContain("Ubuntu, Arch");
    expect(text).toContain("wsl --install -d Debian");
  });

  it("says WSL is a Windows feature elsewhere", () => {
    expect(wslUnavailableMessage({ state: "not-windows" })).toContain(
      "only available on Windows",
    );
  });
});

describe("the executor fails closed when WSL is not there", () => {
  it("is unavailable, not the host's shell, with no distribution", () => {
    const executor = getCommandExecutor({
      platform: "win32",
      terminalShell: { kind: "wsl" },
      wslDistros: [],
    });
    expect(executor.kind).toBe("wsl");
    expect(executor.unavailable).toContain("no WSL distribution is installed");
  });

  it("is unavailable for a distribution that is not installed", () => {
    const executor = getCommandExecutor({
      platform: "win32",
      terminalShell: { kind: "wsl", distro: "Debian" },
      wslDistros: [{ name: "Ubuntu", isDefault: true }],
    });
    expect(executor.unavailable).toContain('"Debian"');
  });

  it("is available with a distribution, and the default shell is never unavailable", () => {
    expect(
      getCommandExecutor({
        platform: "win32",
        terminalShell: { kind: "wsl" },
        wslDistros: [{ name: "Ubuntu", isDefault: true }],
      }).unavailable,
    ).toBeUndefined();
    expect(
      getCommandExecutor({ platform: "win32", terminalShell: "default" })
        .unavailable,
    ).toBeUndefined();
    expect(
      getCommandExecutor({ platform: "linux", env: { SHELL: "/bin/bash" } })
        .unavailable,
    ).toBeUndefined();
  });
});

describe.runIf(process.platform === "win32")("this machine's registry", () => {
  it("lists distributions without starting wsl.exe", () => {
    resetWslStatusCache();
    const distros = readWslDistros();
    // Whatever is installed: names are non-empty and at most one is the default
    for (const d of distros) expect(d.name.length).toBeGreaterThan(0);
    expect(distros.filter((d) => d.isDefault).length).toBeLessThanOrEqual(1);
    expect(distros.map((d) => d.name)).not.toContain("docker-desktop");
  });
});
