import { execFileSync } from "node:child_process";

/**
 * Whether a container runtime can run commands on this machine, and what to
 * tell the person when it cannot (plans/isolation.md, W2 and "Platform
 * awareness"). The same shape as `wslStatus`.
 *
 * Probes start nothing that was not already running: `<runtime> --version`
 * only reads the CLI, and `<runtime> info` only asks a running daemon. A
 * stopped daemon is reported, never started, and nothing is pulled or
 * installed.
 */
export type ContainerRuntime = "docker" | "podman";

export type ContainerStatus =
  /** No container runtime offered for this platform */
  | { state: "unsupported-platform" }
  /** The CLI is not on PATH */
  | { state: "not-installed"; runtime: ContainerRuntime }
  /** The CLI is there but the daemon (or podman's machine) is not answering */
  | { state: "installed-but-unusable"; runtime: ContainerRuntime }
  | { state: "ready"; runtime: ContainerRuntime };

export const CONTAINER_RUNTIMES: readonly ContainerRuntime[] = [
  "docker",
  "podman",
];

/** The default image: has bash and coreutils (`base64`). */
export const DEFAULT_CONTAINER_IMAGE = "ubuntu:24.04";

/** Runs a probe; true when it exited 0 within the time. Injectable for tests. */
export type ContainerProbe = (
  runtime: ContainerRuntime,
  args: string[],
) => boolean;

const realProbe: ContainerProbe = (runtime, args) => {
  try {
    execFileSync(runtime, args, {
      windowsHide: true,
      timeout: args[0] === "info" ? 10_000 : 5_000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
};

const cache = new Map<string, { at: number; status: ContainerStatus }>();

export function resetContainerStatusCache(): void {
  cache.clear();
}

export function containerStatus(
  runtime: ContainerRuntime,
  opts: {
    platform?: NodeJS.Platform;
    probe?: ContainerProbe;
    now?: number;
  } = {},
): ContainerStatus {
  const platform = opts.platform ?? process.platform;
  if (!["win32", "darwin", "linux"].includes(platform)) {
    return { state: "unsupported-platform" };
  }
  const probe = opts.probe ?? realProbe;
  // Only a real probe is cached; a test's is asked every time
  const key = `${platform}:${runtime}`;
  const now = opts.now ?? Date.now();
  const hit = opts.probe ? undefined : cache.get(key);
  if (hit && now - hit.at < 10_000) return hit.status;
  let status: ContainerStatus = { state: "ready", runtime };
  if (probe(runtime, ["--version"])) {
    if (!probe(runtime, ["info"])) {
      status = { state: "installed-but-unusable", runtime };
    }
  } else {
    status = { state: "not-installed", runtime };
  }
  if (!opts.probe) cache.set(key, { at: now, status });
  return status;
}

/**
 * The runtime to use: the one asked for, else docker when it is there, else
 * podman, else docker (so the message names the more common install).
 */
export function pickContainerRuntime(
  wanted: ContainerRuntime | undefined,
  opts: Parameters<typeof containerStatus>[1] = {},
): ContainerStatus {
  if (wanted) return containerStatus(wanted, opts);
  const docker = containerStatus("docker", opts);
  if (docker.state !== "not-installed") return docker;
  const podman = containerStatus("podman", opts);
  return podman.state === "not-installed" ? docker : podman;
}

const INSTALL: Record<ContainerRuntime, string> = {
  docker:
    "Install Docker (Docker Desktop on Windows and macOS: https://docs.docker.com/get-docker/; on Linux your distribution's docker or docker.io package)",
  podman:
    "Install Podman (https://podman.io/docs/installation; on Windows and macOS it also needs `podman machine init` and `podman machine start`)",
};

/**
 * The sentence for a status that is not ready, or undefined when it is. It
 * says how to get the runtime and never does it for the person.
 */
export function containerUnavailableMessage(
  status: ContainerStatus,
): string | undefined {
  switch (status.state) {
    case "ready":
      return undefined;
    case "unsupported-platform":
      return "Running commands in a container is not offered on this platform. Commands were not run.";
    case "not-installed":
      return `Commands are set to run in a ${status.runtime} container, but \`${status.runtime}\` is not installed. ${INSTALL[status.runtime]}. Or set continuous.terminal.shell back to default. The command was not run.`;
    case "installed-but-unusable":
      return `Commands are set to run in a ${status.runtime} container, but ${status.runtime} is not answering: its daemon is not running. ${
        status.runtime === "docker"
          ? "Start Docker Desktop, or on Linux `sudo systemctl start docker`"
          : "Run `podman machine start` (Windows and macOS)"
      }, then run the command again. The command was not run.`;
  }
}
