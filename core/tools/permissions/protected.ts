import * as os from "node:os";
import * as posix from "node:path/posix";
import {
  hasWindowsShortName,
  isConfigPath,
  isSecretPath,
  stripWindowsPathAliases,
} from "./protectedPaths";

/**
 * Paths a tool call should never touch without the user saying yes, whatever
 * the tool's setting or an allow rule says (plans/tool-auto-approval.md,
 * section 5, step 2). A hit makes the call ask. It does not refuse: a person
 * can still approve it. A deny rule is how to refuse.
 *
 * Two lists, because reading `.git/config` is not like reading `~/.aws`:
 * - SECRET paths guard credentials. They apply to every tool and to commands.
 * - CONFIG paths guard things that change what runs later (git hooks, CI,
 *   editor tasks, shell startup). They apply to writes and to commands, since
 *   a command may write; plain file reads and listings of them are fine.
 *
 * Matching ignores case (Windows and macOS volumes do) and slash direction.
 */
export type ProtectedKind = "secret" | "config" | "network";

export interface ProtectedHit {
  kind: ProtectedKind;
  /** The path as it was matched, for the message. */
  path: string;
}

/** Home directory as a forward-slash path, for turning absolute paths into `~/...`. */
export function homeAsPosix(home: string = os.homedir()): string {
  return home.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** `~user` is that account's home, next to this one (`/home/user` or `C:/Users/user`). */
function expandTilde(p: string, home: string): string {
  const h = homeAsPosix(home);
  if (p === "~" || p.startsWith("~/")) {
    return h ? h + p.slice(1) : p;
  }
  if (/^~[^/]/.test(p)) {
    const slash = p.indexOf("/");
    const user = slash === -1 ? p.slice(1) : p.slice(1, slash);
    const rest = slash === -1 ? "" : p.slice(slash);
    const parent = h ? posix.dirname(h) : "/home";
    return `${parent}/${user}${rest}`;
  }
  return p;
}

/**
 * `/proc/<pid>/root` is the process's own filesystem root, so a path written
 * that way is the same file as the path without the prefix.
 */
function stripProcRoot(p: string): string {
  const stripped = p.replace(/^\/proc\/(?:self|\d+)\/root(?=\/|$)/, "");
  return stripped === "" ? "/" : stripped;
}

function isAbsolutePosix(p: string): boolean {
  return p.startsWith("~") || p.startsWith("/") || /^[a-zA-Z]:\//.test(p);
}

/** A relative path is joined to the directory the command or tool runs in. */
function resolveAgainstCwd(p: string, cwd: string | undefined): string {
  if (!cwd || isAbsolutePosix(p)) return p;
  let base = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  base = base.replace(/^\/([a-zA-Z]:\/)/, "$1");
  if (!base || base.startsWith("file:")) return p;
  return posix.join(base, p);
}

function rewriteHome(p: string, home: string): string {
  const h = homeAsPosix(home);
  if (!h || p.startsWith("~")) return p;
  if (p.toLowerCase() === h.toLowerCase()) return "~";
  if (p.toLowerCase().startsWith(h.toLowerCase() + "/")) {
    return "~" + p.slice(h.length);
  }
  return p;
}

/**
 * Make a path comparable: forward slashes, `~` for the home dir, `.` and `..`
 * folded. Relative paths are resolved against `cwd` (the workspace, for a
 * tool call) before that, so a path that climbs out is still recognisable.
 */
export function normalizeProtectedPath(
  raw: string,
  home: string,
  cwd?: string,
): string {
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) return "";
  // A file URI's path is `/C:/Users/...`; drop the slash so it compares as a drive path.
  p = p.replace(/^\/([a-zA-Z]:\/)/, "$1");
  p = p.replace(
    /^(\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=\/|$)/i,
    "~",
  );
  p = stripWindowsPathAliases(p);
  p = expandTilde(p, home);
  p = stripProcRoot(p);
  p = resolveAgainstCwd(p, cwd);
  // Fold `.` and `..` before the home-prefix test. Doing it afterwards leaves
  // a path that climbed back into the home directory looking unrelated.
  if (!p.startsWith("~")) p = posix.normalize(p);
  // A WSL path `/mnt/c/...` is the Windows drive `c:/...`.
  p = p.replace(
    /^\/mnt\/([a-zA-Z])(?=\/|$)/,
    (_, drive: string) => `${drive}:`,
  );
  return rewriteHome(p, home);
}

/** Check one path. `kinds` says which lists apply to this kind of access. */
export function protectedPathHit(
  raw: string | undefined,
  kinds: ProtectedKind[],
  home: string = os.homedir(),
  cwd?: string,
): ProtectedHit | undefined {
  if (!raw) return undefined;
  const path = normalizeProtectedPath(raw, home, cwd);
  if (!path) return undefined;
  if (kinds.includes("secret") && isSecretPath(path)) {
    return { kind: "secret", path };
  }
  if (kinds.includes("config") && isConfigPath(path)) {
    return { kind: "config", path };
  }
  // An 8.3 name can be another spelling of a protected file. Judge the path as
  // written: joining a bare revision such as HEAD~1 to the working directory
  // would make it look like a short name.
  const written = stripWindowsPathAliases(raw.trim().replace(/\\/g, "/"));
  if (hasWindowsShortName(written)) {
    if (kinds.includes("secret")) return { kind: "secret", path: written };
    if (kinds.includes("config")) return { kind: "config", path: written };
  }
  return undefined;
}

/** One line for the prompt. */
export function protectedReason(hit: ProtectedHit): string {
  if (hit.kind === "network") {
    return `This touches the network path ${hit.path}. Looking it up contacts that computer, and on Windows can send your login to it, so it always asks first.`;
  }
  return hit.kind === "secret"
    ? `This touches ${hit.path}, which can hold credentials, so it always asks first.`
    : `This touches ${hit.path}, which can change what runs later, so it always asks first.`;
}
