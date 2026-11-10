import { execFileSync } from "node:child_process";

/**
 * Whether WSL can run commands on this machine, and what to tell the person
 * when it cannot (plans/isolation.md, "Platform awareness").
 *
 * The distributions come from the registry, never from `wsl.exe`. On a
 * Windows machine without WSL, `wsl.exe` in System32 is a stub that opens an
 * interactive installer window on any call (reported by other extensions that
 * probed it), so a status check through it would pop a window. `reg.exe` is
 * always there, starts nothing and answers in a few milliseconds.
 */
export interface WslDistro {
  name: string;
  isDefault: boolean;
}

export type WslStatus =
  /** Not Windows: there is no WSL to offer */
  | { state: "not-windows" }
  /** No distribution is registered: WSL is not installed, or has none yet */
  | { state: "no-distribution" }
  /** The distribution asked for is not among those installed */
  | { state: "distro-missing"; wanted: string; available: string[] }
  | { state: "ready"; distros: WslDistro[] };

/** Docker Desktop's own WSL distributions: not somewhere to run commands. */
const INTERNAL_DISTROS = new Set(["docker-desktop", "docker-desktop-data"]);

const LXSS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";

/** `reg query` output for each distribution's key, as the person's default is a GUID. */
export function parseLxss(
  distroOutput: string,
  defaultOutput: string,
): WslDistro[] {
  const defaultGuid = /DefaultDistribution\s+REG_SZ\s+(\{[^}]+\})/i
    .exec(defaultOutput)?.[1]
    ?.toLowerCase();
  const distros: WslDistro[] = [];
  let guid: string | undefined;
  for (const line of distroOutput.split(/\r?\n/)) {
    const key = /\\Lxss\\(\{[^}]+\})\s*$/i.exec(line.trim());
    if (key) {
      guid = key[1].toLowerCase();
      continue;
    }
    const name = /DistributionName\s+REG_SZ\s+(.+?)\s*$/i.exec(line)?.[1];
    if (name && !INTERNAL_DISTROS.has(name.toLowerCase())) {
      distros.push({ name, isDefault: !!guid && guid === defaultGuid });
    }
  }
  return distros;
}

function reg(args: string[]): string {
  try {
    return execFileSync("reg.exe", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // No such key: nothing is registered
    return "";
  }
}

let cache: { at: number; distros: WslDistro[] } | undefined;

/** The installed distributions, read from the registry and kept for a few seconds. */
export function readWslDistros(now = Date.now()): WslDistro[] {
  if (cache && now - cache.at < 10_000) return cache.distros;
  const distros = parseLxss(
    reg(["query", LXSS, "/s", "/v", "DistributionName"]),
    reg(["query", LXSS, "/v", "DefaultDistribution"]),
  );
  cache = { at: now, distros };
  return distros;
}

export function resetWslStatusCache(): void {
  cache = undefined;
}

export function wslStatus(
  wanted?: string,
  opts: { platform?: NodeJS.Platform; distros?: WslDistro[] } = {},
): WslStatus {
  if ((opts.platform ?? process.platform) !== "win32") {
    return { state: "not-windows" };
  }
  const distros = opts.distros ?? readWslDistros();
  if (distros.length === 0) return { state: "no-distribution" };
  if (
    wanted &&
    !distros.some((d) => d.name.toLowerCase() === wanted.toLowerCase())
  ) {
    return {
      state: "distro-missing",
      wanted,
      available: distros.map((d) => d.name),
    };
  }
  return { state: "ready", distros };
}

/** What to run to get WSL; shown with a copy button, never run for the person. */
export const WSL_INSTALL_COMMAND = "wsl --install";

/**
 * The sentence for a status that is not ready, or undefined when it is. It
 * names the command, says it needs an administrator PowerShell and a restart
 * (Microsoft's install guide), and how to leave the setting.
 */
export function wslUnavailableMessage(status: WslStatus): string | undefined {
  switch (status.state) {
    case "ready":
      return undefined;
    case "not-windows":
      return "Running commands in WSL is only available on Windows. Commands run in this machine's own shell.";
    case "no-distribution":
      return `Commands are set to run in WSL, but no WSL distribution is installed. Open PowerShell as administrator, run \`${WSL_INSTALL_COMMAND}\` (it installs WSL and Ubuntu; \`wsl --list --online\` lists others, \`wsl --install -d <name>\` picks one), restart, and finish the distribution's first-run setup. Or set continuous.terminal.shell back to default.`;
    case "distro-missing":
      return `Commands are set to run in the WSL distribution "${status.wanted}", which is not installed. Installed: ${status.available.join(", ")}. Change continuous.terminal.wslDistro, or install it with \`wsl --install -d ${status.wanted}\` from an administrator PowerShell.`;
  }
}
