import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPosixShell, type ShellKind } from "../../util/shell";
import { runBashCrossCheck } from "./bashCrossCheck";
import { canonicalCmdlet, checkReadCmdlet } from "./powershell";
import { scanCommand } from "./shellScan";

/**
 * Is this command certain to only read? (plans/policy-areas.md, "Which area a
 * call belongs to".) A read-only command is Context use, the same as a
 * read-only tool, so `git log` is decided by the Context level and not by Tool
 * use.
 *
 * Two outcomes, and a claim that travels with the call: vouched, or not, and
 * why not. Being unsure counts against running, so the parser accepts only
 * what it fully understands: words and quoted strings, the operators
 * `| && || ;`, and the redirects to nowhere (`2>/dev/null`, `>/dev/null`,
 * `2>&1`). Substitution, other redirects, variables, groups, background jobs,
 * environment prefixes, UNC paths, and anything over 10,000 characters are
 * not vouched. Every part must then be on the list below with its arguments
 * checked. `awk`, interpreters, `xargs`, `eval` and `source` are never on it,
 * and nothing that contacts the network is.
 */
export type ReadOnlyClaim =
  | { vouched: true; judge: "parser"; claim: string }
  | { vouched: false; judge: "parser"; why: string };

export const MAX_READ_ONLY_COMMAND_LENGTH = 10_000;

const no = (why: string): ReadOnlyClaim => ({
  vouched: false,
  judge: "parser",
  why,
});

type Check = (args: string[]) => string | undefined;

/** Words that are file names: flags skipped, a lone `-` kept, and everything after `--`. */
function positionalOperands(args: string[]): string[] {
  const out: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === "--") {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith("-") && a !== "-") continue;
    out.push(a);
  }
  return out;
}

const anyArgs: Check = () => undefined;

/**
 * A rejected flag also covers the forms the program actually accepts: a short
 * option anywhere in a bundle (`-nOcmd`, `-uo`), a short option with its value
 * attached, and a long option abbreviated to a unique prefix (`--open-f=cmd`).
 * `--` ends options, so later words are files.
 */
const reject =
  (...flags: string[]): Check =>
  (args) => {
    const shorts = new Set(
      flags.filter((f) => /^-[^-]$/.test(f)).map((f) => f.slice(1)),
    );
    for (const a of args) {
      if (a === "--") break;
      const name = a.split("=")[0];
      // `-nOcmd` is `-n` and `-O` with a value, not a single flag named `-nOcmd`.
      if (name.startsWith("-") && !name.startsWith("--")) {
        for (const ch of name.slice(1)) {
          if (shorts.has(ch)) return `argument -${ch} is not recognised`;
        }
      }
      for (const f of flags) {
        if (/^-[^-]$/.test(f)) continue;
        if (name === f) return `argument ${name} is not recognised`;
        if (name.startsWith("--") && name.length > 2 && f.startsWith(name)) {
          return `argument ${name} is not recognised`;
        }
      }
    }
    return undefined;
  };

/** Commands that only read, by lower-cased name, and what to check in their arguments. */
const READ_ONLY: Record<string, Check> = {
  // files and directories
  ls: anyArgs,
  dir: anyArgs,
  cat: anyArgs,
  head: anyArgs,
  tail: reject("-f", "-F", "--follow"),
  wc: anyArgs,
  stat: anyArgs,
  du: anyArgs,
  df: anyArgs,
  tree: reject("-o"),
  pwd: anyArgs,
  realpath: anyArgs,
  readlink: anyArgs,
  basename: anyArgs,
  dirname: anyArgs,
  which: anyArgs,
  file: reject("-m", "-f", "-C", "--magic-file", "--files-from", "--compile"),
  md5sum: anyArgs,
  sha1sum: anyArgs,
  sha256sum: anyArgs,
  // text
  echo: anyArgs,
  grep: anyArgs,
  egrep: anyArgs,
  fgrep: anyArgs,
  rg: reject("--pre", "--hostname-bin"),
  find: reject(
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-delete",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
  ),
  sort: reject("-o", "--output", "--compress-program"),
  // A lone `-` is stdin, an operand. A second operand is the output file
  // (`uniq - package.json`, `uniq in out`).
  uniq: (args) =>
    positionalOperands(args).length > 1
      ? "a second file would be written to"
      : undefined,
  cut: anyArgs,
  tr: anyArgs,
  nl: anyArgs,
  tac: anyArgs,
  rev: anyArgs,
  column: anyArgs,
  comm: anyArgs,
  cmp: anyArgs,
  diff: reject("--output"),
  jq: reject("-f", "--from-file"),
  sed: (args) => {
    // Only `sed -n 'N,Mp'` (print a range), the one form that cannot write
    const [flag, script, ...files] = args;
    if (flag !== "-n" || script === undefined) {
      return "sed is read-only only as -n with a print range";
    }
    if (!/^(\d+(,\d+)?|\$)p$/.test(script)) {
      return "the sed script is not a plain print range";
    }
    return files.some((f) => f.startsWith("-"))
      ? "extra sed flags are not recognised"
      : undefined;
  },
  // the machine
  date: reject("-s", "--set"),
  whoami: anyArgs,
  id: anyArgs,
  uname: anyArgs,
  hostname: (args) =>
    args.length ? "hostname with arguments can set it" : undefined,
  // moving around changes nothing on disk
  cd: (args) => (args.length > 1 ? "cd with several arguments" : undefined),
};

/**
 * Programs PowerShell runs the same way every shell does. Its own cmdlets and
 * their aliases are not a list of names here: they go through powershell.ts,
 * which knows each cmdlet's parameters. Names that are other programs on
 * Windows (`find`, `date`) are not here, so they are not vouched.
 */
const POWERSHELL_EXTERNAL: Record<string, Check> = {
  rg: READ_ONLY.rg,
  jq: READ_ONLY.jq,
  grep: READ_ONLY.grep,
  whoami: anyArgs,
  hostname: READ_ONLY.hostname,
  tree: READ_ONLY.tree,
};

/** Names that move the working directory, after which git's config was not checked. */
const CHANGES_DIRECTORY = new Set(["cd", "set-location"]);

/** git subcommands that read, with the extra arguments each may take. */
const GIT_READ: Record<string, Check> = {
  status: anyArgs,
  log: reject("--output", "-O"),
  diff: reject("--output", "-O", "--ext-diff", "--no-index"),
  show: reject("--output", "--ext-diff"),
  blame: anyArgs,
  "rev-parse": anyArgs,
  "rev-list": reject("--output", "-O"),
  "ls-files": anyArgs,
  "ls-tree": anyArgs,
  "cat-file": (args) =>
    args.some((a) => a.startsWith("--batch") || a.startsWith("--textconv"))
      ? "cat-file batch and textconv modes are not recognised"
      : undefined,
  describe: anyArgs,
  shortlog: reject("--output", "-O"),
  "merge-base": anyArgs,
  "name-rev": anyArgs,
  "for-each-ref": anyArgs,
  "diff-tree": reject("--output"),
  grep: reject("--open-files-in-pager", "-O"),
  branch: (args) =>
    args.length === 0 ||
    args.every((a) =>
      [
        "-a",
        "-r",
        "-v",
        "-vv",
        "--list",
        "-l",
        "--show-current",
        "--all",
        "--remotes",
      ].includes(a),
    )
      ? undefined
      : "branch with other arguments can create or delete",
  tag: (args) =>
    args.length === 0 || args.every((a) => ["-l", "--list", "-n"].includes(a))
      ? undefined
      : "tag with other arguments can create or delete",
  remote: (args) =>
    args.length === 0 ||
    (args.length === 1 && ["-v", "--verbose"].includes(args[0]))
      ? undefined
      : "remote with other arguments can change or contact one",
  stash: (args) => {
    if (args[0] !== "list" && args[0] !== "show") {
      return "only stash list and stash show only read";
    }
    // `stash show` is a diff, so it takes diff's output option
    return args[0] === "show"
      ? reject("--output", "-O")(args.slice(1))
      : undefined;
  },
};

/** The global flags git accepts before its subcommand without running anything. */
const GIT_SAFE_GLOBAL = new Set(["--no-pager", "--no-optional-locks", "-P"]);

/**
 * A config key whose value is a program, or a section git runs as a program.
 * Matched on the parsed key (`core.fsmonitor`, `diff.x.command`), so a
 * one-line section and a subsection are the same as a key on its own line.
 */
const GIT_RUNS_KEY =
  /(^|\.)(fsmonitor|hookspath|sshcommand|textconv|command|external|askpass|editor|pager|program|alternaterefscommand)$/i;

function gitSectionName(header: string): string {
  const h = header.trim();
  const quoted = /^([A-Za-z0-9][A-Za-z0-9-]*)\s+"((?:\\.|[^"\\])*)"\s*$/.exec(
    h,
  );
  if (quoted) {
    return `${quoted[1].toLowerCase()}.${quoted[2].replace(/\\"/g, '"').toLowerCase()}`;
  }
  return h.toLowerCase();
}

function gitSectionRunsPrograms(section: string): boolean {
  return /^(hook|filter|pager)(\.|$)/i.test(section);
}

function isGitIncludeSection(section: string): boolean {
  return /^(include|includeif)(\.|$)/i.test(section);
}

function gitKeyRunsPrograms(section: string, line: string): boolean {
  const eq = line.indexOf("=");
  if (eq <= 0) return false;
  const name = line.slice(0, eq).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  const full = section ? `${section}.${name}` : name;
  return GIT_RUNS_KEY.test(full) || gitSectionRunsPrograms(full);
}

/** Drop an unquoted `#` comment. `;` only starts a comment at the beginning of a line. */
function withoutGitComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** `path` values of include and includeIf, in the order they appear. */
function gitIncludePaths(text: string): string[] {
  const paths: string[] = [];
  let including = false;
  const take = (line: string) => {
    const m = /^path\s*=\s*(.*)$/i.exec(line.trim());
    if (!m) return;
    let value = m[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value) paths.push(value);
  };
  for (const raw of text.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    const line = withoutGitComment(raw).trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\](.*)$/.exec(line);
    if (header) {
      including = isGitIncludeSection(gitSectionName(header[1]));
      if (including && header[2].trim()) take(header[2]);
      continue;
    }
    if (including) take(line);
  }
  return paths;
}

/** An include path is relative to the file that names it. `~/` is the home directory. */
function resolveGitInclude(
  fromFile: string,
  spec: string,
  home: string,
): string {
  let p = spec.trim();
  if (p.startsWith("~/")) p = path.join(home, p.slice(2));
  else if (p === "~") p = home;
  if (!path.isAbsolute(p)) p = path.resolve(path.dirname(fromFile), p);
  return p;
}

const GIT_CONFIG_READ_LIMIT = 32;

/** True when this config text names a program git would run. */
function gitConfigRunsPrograms(text: string): boolean {
  let section = "";
  for (const raw of text.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    const line = withoutGitComment(raw).trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\](.*)$/.exec(line);
    if (header) {
      section = gitSectionName(header[1]);
      if (gitSectionRunsPrograms(section)) return true;
      const rest = header[2].trim();
      if (rest && gitKeyRunsPrograms(section, rest)) return true;
      continue;
    }
    if (section && gitSectionRunsPrograms(section)) return true;
    if (gitKeyRunsPrograms(section, line)) return true;
  }
  return false;
}

function gitEnvRunsPrograms(env: Record<string, string | undefined>): boolean {
  const n = Number(env.GIT_CONFIG_COUNT);
  if (!Number.isInteger(n) || n <= 0) return false;
  for (let i = 0; i < Math.min(n, 64); i++) {
    const key = env[`GIT_CONFIG_KEY_${i}`];
    if (!key) continue;
    const full = key.trim().toLowerCase();
    if (GIT_RUNS_KEY.test(full) || gitSectionRunsPrograms(full)) return true;
  }
  return false;
}

export interface ReadOnlyOptions {
  /**
   * The shell that will run the command (resolveShell). A command means what
   * its shell makes of it, so without a shell we understand, nothing is vouched.
   */
  shell?: ShellKind;
  /** The folder the command runs in, to read the repository's git config */
  cwd?: string;
  /** For tests: the text of a git config file, or undefined when absent */
  readGitConfig?: (file: string) => string | undefined;
  /** For tests: what a path is, "dir" or "file", or undefined when absent */
  probe?: (file: string) => "dir" | "file" | undefined;
  home?: string;
  /** For tests: where git looks up config. Absent means the process environment. */
  env?: Record<string, string | undefined>;
}

function defaultProbe(file: string): "dir" | "file" | undefined {
  try {
    return fs.statSync(file).isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
}

function defaultReadGitConfig(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * `git status`, `git diff` and the like run `core.fsmonitor`, hooks and
 * filters from the repository's own config: this was exploited across seven
 * agents in 2026. So git is vouched only when neither the repository's config
 * nor the user's names such a thing, and not at all without a folder to look
 * in.
 */
function gitIsSafe(opts: ReadOnlyOptions): string | undefined {
  if (!opts.cwd)
    return "git is not vouched without a folder to check its config in";
  const read = opts.readGitConfig ?? defaultReadGitConfig;
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  if (gitEnvRunsPrograms(env)) {
    return "git config from the environment can run programs (fsmonitor, hooks, filters or similar)";
  }
  // A file URI's path is "/C:/..." on Windows, which fs does not take
  const cwd = opts.cwd.replace(/^\/([A-Za-z]:)/, "$1");
  const probe = opts.probe ?? defaultProbe;
  // System, then global, then the repository. GIT_CONFIG_GLOBAL replaces both
  // ~/.gitconfig and $XDG_CONFIG_HOME/git/config; GIT_CONFIG_SYSTEM replaces
  // /etc/gitconfig. The repository is the nearest folder up the tree with a
  // .git: the workspace is often a subfolder of it.
  const files: string[] = [];
  if (env.GIT_CONFIG_SYSTEM) files.push(env.GIT_CONFIG_SYSTEM);
  else files.push("/etc/gitconfig");
  if (env.GIT_CONFIG_GLOBAL) {
    files.push(env.GIT_CONFIG_GLOBAL);
  } else {
    files.push(path.join(home, ".gitconfig"));
    const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
    files.push(path.join(xdg, "git", "config"));
  }
  for (let dir = cwd; ;) {
    const kind = probe(path.join(dir, ".git"));
    if (kind === "file") {
      // A worktree or submodule: its config is somewhere this does not look
      return `${dir} is a git worktree or submodule, whose config was not checked`;
    }
    if (kind === "dir") {
      files.push(path.join(dir, ".git", "config"));
      files.push(path.join(dir, ".git", "config.worktree"));
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // Optional files may be absent. An include target is required: if it cannot
  // be read, or the chain loops, the config was not fully checked.
  const queue: { file: string; required: boolean }[] = files.map((file) => ({
    file,
    required: false,
  }));
  const seen = new Set<string>();
  let reads = 0;
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const key = item.file.replace(/\\/g, "/");
    if (seen.has(key)) {
      if (item.required) {
        return `git config (${item.file}) can run programs (fsmonitor, hooks, filters or similar)`;
      }
      continue;
    }
    seen.add(key);
    reads += 1;
    if (reads > GIT_CONFIG_READ_LIMIT) {
      return `git config (${item.file}) can run programs (fsmonitor, hooks, filters or similar)`;
    }
    const text = read(item.file);
    if (!text) {
      if (item.required) {
        return `git config (${item.file}) can run programs (fsmonitor, hooks, filters or similar)`;
      }
      continue;
    }
    if (gitConfigRunsPrograms(text)) {
      return `git config (${item.file}) can run programs (fsmonitor, hooks, filters or similar)`;
    }
    for (const spec of gitIncludePaths(text)) {
      queue.push({
        file: resolveGitInclude(item.file, spec, home),
        required: true,
      });
    }
  }
  return undefined;
}

/**
 * cmd's own commands: cmd runs these itself, before it looks for a file of
 * that name, so they are the same everywhere. Every other name in cmd is a
 * program, and cmd searches the current directory for programs first, so any
 * of them can be a file in the repository: not vouched.
 */
const CMD_DIR_SWITCH = /^\/(-?[abcdlnopqrstwx4?]|[aot]:[a-z-]+)$/i;
const CMD_INTERNAL: Record<string, Check> = {
  dir: (args) =>
    args.every((a) => !a.startsWith("/") || CMD_DIR_SWITCH.test(a))
      ? undefined
      : "dir with a switch that is not recognised",
  type: (args) =>
    args.some((a) => a.startsWith("/")) ? "type takes no switches" : undefined,
  cd: (args) =>
    args.length === 0 ||
    args.length === 1 ||
    (args.length === 2 && args[0].toLowerCase() === "/d")
      ? undefined
      : "cd with several arguments",
  echo: anyArgs,
  ver: (args) => (args.length ? "ver takes no arguments" : undefined),
  vol: (args) => (args.length > 1 ? "vol with several arguments" : undefined),
  path: (args) => (args.length ? "path with an argument sets it" : undefined),
  // Listing the variables only: one name prints those that start with it
  set: (args) =>
    args.length > 1 || args.some((a) => a.startsWith("/"))
      ? "set with a switch or several arguments"
      : undefined,
};
CMD_INTERNAL.chdir = CMD_INTERNAL.cd;

/**
 * For each simple command, whether the shell will expand an unquoted glob
 * (`* ? [` ) before a `--` word. A name produced by that expansion is an
 * argument, so a file named like a flag is a flag. Quoted globs are patterns,
 * not file names, and words after `--` are not options.
 */
function unquotedGlobBeforeOptionsEnd(command: string): boolean[] {
  const flags: boolean[] = [];
  let quote: "'" | '"' | null = null;
  let word = "";
  let glob = false;
  let optionsEnded = false;
  const endWord = () => {
    if (word === "--") optionsEnded = true;
    word = "";
  };
  const endCommand = () => {
    endWord();
    flags.push(glob);
    glob = false;
    optionsEnded = false;
  };
  let saw = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += ".";
      saw = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      saw = true;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < command.length) {
        word += ".";
        i++;
      }
      saw = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      endCommand();
      i++;
      saw = true;
      continue;
    }
    if (c === "|" || c === ";" || c === "\n") {
      endCommand();
      saw = true;
      continue;
    }
    if (!optionsEnded && (c === "*" || c === "?" || c === "[")) glob = true;
    word += c;
    saw = true;
  }
  if (saw) endCommand();
  return flags;
}

/** Does this command only read? See the file comment for what that takes. */
export function classifyReadOnly(
  command: string,
  opts: ReadOnlyOptions = {},
): ReadOnlyClaim {
  if (typeof command !== "string" || !command.trim()) return no("no command");
  if (command.length > MAX_READ_ONLY_COMMAND_LENGTH) {
    return no(`the command is over ${MAX_READ_ONLY_COMMAND_LENGTH} characters`);
  }
  const shell = opts.shell;
  if (!shell) return no("the shell that runs it is not known");
  if (shell === "unknown") return no("this shell is not parsed");
  // UNC paths reach another computer
  if (/(^|[\s'"])(\\\\|\/\/)[^\s\\/]+[\\/]/.test(command)) {
    return no("a network path (UNC) is named");
  }
  const scanned = scanCommand(command, shell);
  if (!scanned.ok) return no(scanned.why);
  // A second reader, when one is loaded: if the bash grammar sees other
  // commands than the scanner does, the scanner is not to be trusted here
  if (isPosixShell(shell)) {
    const disagreement = runBashCrossCheck(command, scanned.graph);
    if (disagreement) return no(disagreement);
  }

  const names: string[] = [];
  // After a cd the command runs somewhere whose git config was not checked
  let movedDirectory = false;
  const globRisk = unquotedGlobBeforeOptionsEnd(command);
  if (
    globRisk.length !== scanned.graph.commands.length &&
    globRisk.some(Boolean)
  ) {
    return no("a glob can expand to a flag");
  }
  const globAt = (i: number) =>
    globRisk.length === scanned.graph.commands.length && globRisk[i] === true;
  for (let index = 0; index < scanned.graph.commands.length; index++) {
    const { words } = scanned.graph.commands[index];
    const [first, ...rest] = words;
    // An environment prefix (FOO=bar cmd) can change what a command does
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      return no("an environment prefix");
    }
    const name = first.toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      return no(`"${first}" is not a plain command name`);
    }
    if (shell === "cmd") {
      const check = CMD_INTERNAL[name];
      if (!check) {
        return no(
          `${name} is not one of cmd's own commands, so it may be a file`,
        );
      }
      const problem = check(rest);
      if (problem) return no(`${name}: ${problem}`);
      if (globAt(index) && check !== anyArgs) {
        return no("a glob can expand to a flag");
      }
      names.push(name);
      continue;
    }
    if (CHANGES_DIRECTORY.has(name)) movedDirectory = true;
    if (name === "git") {
      if (movedDirectory) {
        return no(
          "git after cd runs in a folder whose git config was not checked",
        );
      }
      const unsafe = gitIsSafe(opts);
      if (unsafe) return no(unsafe);
      // Global flags before the subcommand: only the ones that run nothing
      let i = 0;
      while (i < rest.length && rest[i].startsWith("-")) {
        if (!GIT_SAFE_GLOBAL.has(rest[i])) {
          return no(
            `git flag ${rest[i]} before the subcommand is not recognised`,
          );
        }
        i++;
      }
      const sub = rest[i];
      const check = sub ? GIT_READ[sub] : undefined;
      if (!check)
        return no(
          `git ${sub ?? ""} is not on the read-only list`.replace("  ", " "),
        );
      const problem = check(rest.slice(i + 1));
      if (problem) return no(`git ${sub}: ${problem}`);
      if (globAt(index)) return no("a glob can expand to a flag");
      names.push(`git ${sub}`);
      continue;
    }
    if (shell === "powershell" && !(name in POWERSHELL_EXTERNAL)) {
      // A cmdlet or an alias of one: known by its parameters, not its name
      const cmdlet = canonicalCmdlet(name);
      if (cmdlet) {
        if (CHANGES_DIRECTORY.has(cmdlet)) movedDirectory = true;
        const problem = checkReadCmdlet(cmdlet, rest);
        if (problem) return no(problem);
        if (globAt(index)) return no("a glob can expand to a flag");
        names.push(cmdlet);
        continue;
      }
    }
    const list = shell === "powershell" ? POWERSHELL_EXTERNAL : READ_ONLY;
    const check = list[name];
    if (!check) {
      return no(
        `${name} is not on the ${shell === "powershell" ? "PowerShell " : ""}read-only list`,
      );
    }
    const problem = check(rest);
    if (problem) return no(`${name}: ${problem}`);
    if (globAt(index) && check !== anyArgs) {
      return no("a glob can expand to a flag");
    }
    names.push(name);
  }
  return {
    vouched: true,
    judge: "parser",
    claim: `only reads: ${[...new Set(names)].join(", ")}`,
  };
}
