import { parseCommand } from "./command";
import { canonicalCmdlet, isPowerShellAlias } from "./powershell";
import {
  commandName,
  dequote,
  extractSubstitutions,
  splitRawWords,
  stripGrouping,
} from "./shellWords";

/**
 * Every string a deny or ask rule should be tried against for a command.
 * It reads the command the way the shell will: quotes and escapes removed
 * (`git 'push'`, `g\it`, `$'\x67it'`), directories and `.exe` dropped from the
 * command name, `git -C x -c y push` read as `git push`, wrappers such as
 * `sudo`, `env` and `timeout` skipped, and the commands inside `$(...)`,
 * `bash -c`, `powershell -Command`, `python -c`, `eval`, `xargs` and pipes
 * into a shell included. It only ever adds candidates, so a deny or ask rule
 * can match more, never less.
 */
const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const PS_SHELLS = new Set(["powershell", "pwsh"]);
const INTERPRETER = /^(python|node|nodejs|deno|bun|perl|ruby|php|lua)[\d.]*$/;
const INLINE_FLAGS = new Set(["-c", "-e", "-p", "-r", "--eval", "--print"]);
const GIT_OPTS_WITH_ARG = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);
const XARGS_OPTS_WITH_ARG = new Set(["-n", "-I", "-P", "-d", "-L", "-s", "-E"]);
const MAX_DEPTH = 4;
const MAX_CANDIDATES = 800;

/** An alias's cmdlet in its usual capitalisation: `Remove-Item`, not `remove-item`. */
function canonicalCmdletName(alias: string): string {
  return (canonicalCmdlet(alias) ?? alias)
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("-");
}

/** Text inside matching quotes, for scripts passed to `python -c`, `sh <<<` and similar. */
function quotedLiterals(text: string): string[] {
  const out: string[] = [];
  const re = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[2]);
  return out;
}

function skipGitOptions(tail: string[]): string[] {
  let i = 0;
  while (i < tail.length && tail[i].startsWith("-")) {
    i += GIT_OPTS_WITH_ARG.has(tail[i]) ? 2 : 1;
  }
  return tail.slice(i);
}

function unquoteWord(word: string): string {
  return dequote(stripGrouping(word));
}

/** Scripts a command word can run, so a rule sees the command inside them. */
function nested(
  name: string,
  tail: string[],
  depth: number,
  out: Set<string>,
): void {
  const run = (script: string | undefined) => {
    if (script) addCommand(script, depth + 1, out);
  };
  if (POSIX_SHELLS.has(name)) {
    const k = tail.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
    if (k >= 0) run(tail[k + 1]);
  } else if (PS_SHELLS.has(name)) {
    const k = tail.findIndex((w) => /^-(c|command)$/i.test(w));
    if (k >= 0) run(tail.slice(k + 1).join(" "));
  } else if (name === "cmd") {
    const k = tail.findIndex((w) => /^\/[ck]$/i.test(w));
    if (k >= 0) run(tail.slice(k + 1).join(" "));
  } else if (name === "eval") {
    run(tail.join(" "));
  } else if (INTERPRETER.test(name)) {
    const k = tail.findIndex((w) => INLINE_FLAGS.has(w.toLowerCase()));
    if (k >= 0 && tail[k + 1]) {
      for (const lit of quotedLiterals(tail[k + 1])) run(lit);
    }
  } else if (
    name === "awk" ||
    name === "gawk" ||
    name === "nawk" ||
    name === "mawk"
  ) {
    const systemCall = /system\s*\(\s*(["'])([\s\S]*?)\1\s*\)/g;
    for (const w of tail) {
      for (const s of [w, ...quotedLiterals(w)]) {
        systemCall.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = systemCall.exec(s))) run(m[2]);
      }
    }
  }
}

const ASSIGN_KEYWORD = /^(?:export|declare|typeset|local|readonly)\b\s+/;

/** `NAME=value`, including `export`/`declare` and their flags. The whole part must be the assignment. */
function assignmentOf(part: string): [string, string] | undefined {
  let body = part.trim();
  if (ASSIGN_KEYWORD.test(body)) {
    body = body.replace(ASSIGN_KEYWORD, "");
    body = body.replace(/^(?:-[A-Za-z]+\s+)+/, "");
  }
  const m = /^([A-Za-z_]\w*)=((?:\S)*)$/.exec(body);
  if (!m) return undefined;
  return [m[1], dequote(m[2])];
}

/** `printf -v NAME value` assigns NAME, the same as `NAME=value`. */
function printfAssignment(part: string): [string, string] | undefined {
  const words = splitRawWords(part).map(unquoteWord);
  if (words[0] !== "printf") return undefined;
  const v = words.findIndex((w, i) => i > 0 && w === "-v");
  if (v < 0 || words[v + 1] === undefined || words[v + 2] === undefined) {
    return undefined;
  }
  return [words[v + 1], words[v + 2]];
}

/** Replace known variables and `$IFS`, repeatedly, so `H=$G` then `$H` resolves. */
function expandKnown(text: string, vars: Record<string, string>): string {
  let cur = text;
  for (let n = 0; n < 8; n++) {
    const next = cur
      .replace(/\$\{IFS\}|\$IFS/g, " ")
      .replace(
        /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
        (s, braced: string | undefined, plain: string | undefined) => {
          const name = braced || plain || "";
          return Object.prototype.hasOwnProperty.call(vars, name)
            ? vars[name]
            : s;
        },
      );
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** `{git,push}` is the words `git` and `push`. Quoted braces are left alone. */
function expandBraceWord(word: string): string[] {
  if (word.startsWith("'") || word.startsWith('"')) return [word];
  const m = /^((?:[^{}\\]|\\.)*)\{([^{}]*)\}(.*)$/.exec(word);
  if (!m || !m[2].includes(",")) return [word];
  const alts = m[2].split(",");
  if (alts.length > 16) return [word];
  const out: string[] = [];
  for (const alt of alts) {
    for (const next of expandBraceWord(m[1] + alt + m[3])) {
      out.push(next);
      if (out.length > 32) return [word];
    }
  }
  return out;
}

function expandBraces(part: string): string | undefined {
  const words = splitRawWords(part);
  if (words.length === 0) return undefined;
  let changed = false;
  const expanded: string[] = [];
  for (const w of words) {
    const pieces = expandBraceWord(w);
    if (pieces.length !== 1 || pieces[0] !== w) changed = true;
    expanded.push(...pieces);
  }
  return changed ? expanded.map(unquoteWord).join(" ") : undefined;
}

function addPart(part: string, depth: number, out: Set<string>): void {
  if (out.size > MAX_CANDIDATES) return;
  out.add(part);
  const rawWords = splitRawWords(part).map(stripGrouping).filter(Boolean);
  const words = rawWords.map(dequote).filter(Boolean);
  if (words.length === 0) return;
  out.add(words.join(" "));

  for (let i = 0; i < rawWords.length; i++) {
    const tail = rawWords.slice(i + 1).map(unquoteWord);
    // A Windows path keeps its backslashes in the raw word; `g\it` loses them.
    // Try both readings of the command word.
    const names = new Set([
      commandName(unquoteWord(rawWords[i])),
      commandName(rawWords[i]),
    ]);
    for (const name of names) {
      if (!name) continue;
      out.add([name, ...tail].join(" "));
      // PowerShell's `rm` is Remove-Item: a rule on either sees both
      if (isPowerShellAlias(name)) {
        out.add([canonicalCmdletName(name), ...tail].join(" "));
      }
      if (name === "git") out.add(["git", ...skipGitOptions(tail)].join(" "));
      if (depth < MAX_DEPTH) nested(name, tail, depth, out);
    }
  }
}

/** Each part of a command, plus what is inside substitutions, scripts and simple variables. */
function addCommand(command: string, depth: number, out: Set<string>): void {
  if (out.size > MAX_CANDIDATES) return;
  const parts = parseCommand(command).parts;
  const vars: Record<string, string> = {};

  for (const p of parts) {
    addPart(p, depth, out);
    const assign = assignmentOf(p) ?? printfAssignment(p);
    if (assign) vars[assign[0]] = expandKnown(assign[1], vars);
    if (/[$\{]/.test(p)) {
      const expanded = expandKnown(p, vars);
      const text = expanded;
      if (text !== p) addPart(text, depth, out);
      const braced = expandBraces(text);
      if (braced && braced !== text) addPart(braced, depth, out);
    }
  }
  if (depth >= MAX_DEPTH) return;

  for (const sub of extractSubstitutions(command)) {
    addCommand(sub, depth + 1, out);
  }

  const names = parts.map((p) =>
    commandName(unquoteWord(splitRawWords(p)[0] ?? "")),
  );
  // `echo '...' | sh`, `sh <<< '...'`: text fed to a shell is a script.
  const feedsShell =
    /<<</.test(command) ||
    names.some(
      (n, i) => POSIX_SHELLS.has(n) && !/\s-[a-z]*c\b/.test(" " + parts[i]),
    );
  if (feedsShell) {
    for (const p of parts) {
      for (const lit of quotedLiterals(p)) addCommand(lit, depth + 1, out);
    }
  }
  // `echo push | xargs git` runs `git push`.
  parts.forEach((p, i) => {
    if (names[i] !== "xargs") return;
    const w = splitRawWords(p).slice(1).map(unquoteWord);
    let k = 0;
    while (k < w.length && w[k].startsWith("-")) {
      k += XARGS_OPTS_WITH_ARG.has(w[k]) ? 2 : 1;
    }
    const tail = w.slice(k).join(" ");
    if (!tail) return;
    parts.forEach((q, j) => {
      if (j !== i && (names[j] === "echo" || names[j] === "printf")) {
        const args = splitRawWords(q).slice(1).map(unquoteWord).join(" ");
        addPart(`${tail} ${args}`.trim(), depth + 1, out);
      }
    });
  });
}

/** Every string a deny or ask rule should be tried against for a whole command. */
export function commandCandidates(command: string): string[] {
  const out = new Set<string>([command]);
  addCommand(command, 0, out);
  return [...out];
}

/** The candidates for one part of a command. */
export function ruleCandidates(part: string): string[] {
  return commandCandidates(part);
}
