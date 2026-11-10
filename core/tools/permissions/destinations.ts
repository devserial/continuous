import { canonicalCmdlet } from "./powershell";

/**
 * Where a network command reaches (plans/command-analysis.md, P10): the
 * destinations of one resolved command, so a rule can say
 * `runTerminalCommand(host:*.aliyuncs.com)` or `net:metadata` instead of
 * matching the text of the command.
 *
 * Reads the destinations a command names: URL operands and the flags that take
 * a URL or host (curl `--url`, `-x`, `--resolve`, `--connect-to`; wget `-e
 * http_proxy=`; PowerShell `-Uri`, `-Proxy`), git remotes (URLs and scp-style
 * `user@host:path`), and the host operands of ssh, scp, rsync, nc and telnet.
 *
 * What it does not see is reported, not hidden: a destination built from a
 * variable, a substitution or a file of URLs is returned in `unresolved`, and
 * a host rule never matches it. That is not "safe": the caller (the policy
 * engine) treats a command it cannot read as unsure, and a program with no
 * reader here has no destinations at all.
 */
export interface Destination {
  /** The program that reaches it, in its usual lower-case name */
  program: string;
  scheme?: string;
  /** Lower case, no trailing dot, no brackets; an IPv4 address in dotted form */
  host: string;
  port?: number;
  /** The word as written */
  raw: string;
}

export interface Destinations {
  destinations: Destination[];
  /** Words that name a destination this reader could not resolve */
  unresolved: string[];
}

// ---------------------------------------------------------------- hosts

/** One part of an IPv4 address: decimal, 0x hex or leading-zero octal. */
function ipv4Part(part: string): number | undefined {
  if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part, 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part, 8);
  if (/^(0|[1-9]\d*)$/.test(part)) return parseInt(part, 10);
  return undefined;
}

/**
 * An IPv4 address in any spelling `inet_aton` takes (1 to 4 parts, each
 * decimal, hex or octal) as dotted decimal, or undefined when it is not one.
 */
export function parseIPv4(text: string): string | undefined {
  const parts = text.split(".");
  if (parts.length < 1 || parts.length > 4) return undefined;
  const nums = parts.map(ipv4Part);
  if (nums.some((n) => n === undefined)) return undefined;
  const n = nums as number[];
  const last = n[n.length - 1];
  const head = n.slice(0, -1);
  if (head.some((x) => x > 255)) return undefined;
  const room = 256 ** (5 - n.length);
  if (last >= room) return undefined;
  let value = last;
  head.forEach((x, i) => (value += x * 256 ** (3 - i)));
  return [24, 16, 8, 0].map((s) => Math.floor(value / 2 ** s) % 256).join(".");
}

/** `::ffff:a.b.c.d` or `::ffff:7f00:1` as dotted IPv4. */
function mappedIPv4(host: string): string | undefined {
  const dotted = /^(?:0:0:0:0:0:|::)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted) return parseIPv4(dotted[1]);
  const hex = /^(?:0:0:0:0:0:|::)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(
    host,
  );
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return undefined;
}

/**
 * A host as one canonical string: lower case, no trailing dot, no brackets,
 * an IPv4 address in any spelling (`2130706433`, `0x7f.1`, `0177.0.0.1`) as
 * dotted decimal, and an IPv4-mapped IPv6 address as the IPv4 it holds.
 */
export function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.replace(/%.*$/, "").replace(/\.+$/, "");
  if (host.includes(":")) return mappedIPv4(host) ?? host;
  return parseIPv4(host) ?? host;
}

// ---------------------------------------------------------------- URLs

const UNRESOLVED = /[$`]|%[A-Za-z_]+%|\$\(|\{\{/;

function parsePort(text: string | undefined): number | undefined {
  if (!text || !/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port > 0 && port < 65536 ? port : undefined;
}

/** `host`, `host:port`, `[v6]` or `[v6]:port`. */
function splitHostPort(text: string): { host: string; port?: number } {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (v6) return { host: v6[1], port: parsePort(v6[2]) };
  const colons = text.split(":").length - 1;
  if (colons === 1) {
    const [host, port] = text.split(":");
    return { host, port: parsePort(port) };
  }
  // A bare IPv6 address has several colons and no port
  return { host: text };
}

/**
 * A destination from a URL (`https://user@host:8443/p`), or from a bare
 * `host[:port][/path]` as curl accepts it. Undefined when the word is not one.
 */
export function parseDestination(
  word: string,
  program: string,
): Destination | undefined {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(word);
  if (m) {
    const authority = m[2].includes("@") ? m[2].split("@").pop()! : m[2];
    if (!authority) return undefined;
    const { host, port } = splitHostPort(authority);
    if (!host) return undefined;
    return {
      program,
      scheme: m[1].toLowerCase(),
      host: normalizeHost(host),
      port,
      raw: word,
    };
  }
  const bare = /^([^/?#\s]+)(?:[/?#].*)?$/.exec(word);
  if (!bare || word.startsWith("-")) return undefined;
  const authority = bare[1].includes("@") ? bare[1].split("@").pop()! : bare[1];
  const { host, port } = splitHostPort(authority);
  // A bare word is a host only if it looks like one: an address, localhost, or a dotted name
  if (
    !host ||
    !(
      host === "localhost" ||
      parseIPv4(host) !== undefined ||
      host.includes(":") ||
      /^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i.test(host)
    )
  ) {
    return undefined;
  }
  return { program, host: normalizeHost(host), port, raw: word };
}

/** scp-style `user@host:path` or `host:path` (not a Windows drive, not a URL). */
function parseScpStyle(word: string, program: string): Destination | undefined {
  if (word.includes("://") || /^[A-Za-z]:[\\/]/.test(word)) return undefined;
  const m = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/@\s]+):(?!\d+$)/.exec(word);
  if (!m) return undefined;
  const host = normalizeHost(m[1]);
  if (!host) return undefined;
  return { program, host, raw: word };
}

// ---------------------------------------------------------------- programs

/** Flags that take a value, so the value is not mistaken for a URL operand. */
const CURL_VALUE_FLAGS = new Set([
  "-H",
  "--header",
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "--data-ascii",
  "-X",
  "--request",
  "-u",
  "--user",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "-o",
  "--output",
  "-b",
  "--cookie",
  "-c",
  "--cookie-jar",
  "-T",
  "--upload-file",
  "-F",
  "--form",
  "-m",
  "--max-time",
  "--connect-timeout",
  "-w",
  "--write-out",
  "-K",
  "--config",
  "-r",
  "--range",
  "--retry",
  "--retry-delay",
  "-E",
  "--cert",
  "--key",
  "--cacert",
  "-U",
  "--proxy-user",
  "--interface",
  "--limit-rate",
  "-C",
  "--continue-at",
  "--json",
  "--oauth2-bearer",
  "--aws-sigv4",
  "--dns-servers",
]);
const WGET_VALUE_FLAGS = new Set([
  "-O",
  "--output-document",
  "-o",
  "--output-file",
  "-P",
  "--directory-prefix",
  "-U",
  "--user-agent",
  "--header",
  "--user",
  "--password",
  "-t",
  "--tries",
  "-T",
  "--timeout",
  "-w",
  "--wait",
  "-Q",
  "--quota",
  "-i",
  "--input-file",
  "-B",
  "--base",
  "--post-data",
  "--post-file",
  "--referer",
  "-l",
  "--level",
  "--limit-rate",
  "--ca-certificate",
  "--certificate",
  "--private-key",
]);
const SSH_VALUE_FLAGS = new Set([
  "-p",
  "-i",
  "-l",
  "-o",
  "-F",
  "-L",
  "-R",
  "-D",
  "-b",
  "-c",
  "-e",
  "-E",
  "-m",
  "-O",
  "-Q",
  "-S",
  "-W",
  "-w",
  "-B",
  "-I",
  "-P",
]);
const NC_VALUE_FLAGS = new Set([
  "-p",
  "-s",
  "-w",
  "-e",
  "-i",
  "-q",
  "-I",
  "-O",
  "-T",
  "-x",
  "-X",
]);

// Flags that carry a destination, so they must be read as flags with a value
for (const f of [
  "-x",
  "--proxy",
  "--url",
  "--resolve",
  "--connect-to",
  "--proxy-header",
]) {
  CURL_VALUE_FLAGS.add(f);
}
for (const f of ["-e", "--execute"]) WGET_VALUE_FLAGS.add(f);
SSH_VALUE_FLAGS.add("-J");

type Reader = (words: string[], program: string, out: Destinations) => void;

/** Adds a destination from a word, or notes the word as unresolved. */
function add(
  out: Destinations,
  word: string,
  program: string,
  parse: (w: string, p: string) => Destination | undefined = parseDestination,
): void {
  if (UNRESOLVED.test(word)) {
    out.unresolved.push(word);
    return;
  }
  const d = parse(word, program);
  if (d) out.destinations.push(d);
}

/** The operands (words that are not flags or flag values) and the flags with their values. */
function split(
  words: string[],
  valueFlags: Set<string>,
): { operands: string[]; flags: Array<[string, string | undefined]> } {
  const operands: string[] = [];
  const flags: Array<[string, string | undefined]> = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      operands.push(...words.slice(i + 1));
      break;
    }
    if (w.startsWith("--") && w.includes("=")) {
      const eq = w.indexOf("=");
      flags.push([w.slice(0, eq), w.slice(eq + 1)]);
    } else if (w.startsWith("-") && w.length > 1) {
      // `-xhttp://p` (a short flag with its value attached)
      const short = w.slice(0, 2);
      if (!w.startsWith("--") && w.length > 2 && valueFlags.has(short)) {
        flags.push([short, w.slice(2)]);
      } else if (valueFlags.has(w)) {
        flags.push([w, words[i + 1]]);
        i++;
      } else {
        flags.push([w, undefined]);
      }
    } else {
      operands.push(w);
    }
  }
  return { operands, flags };
}

const readCurl: Reader = (words, program, out) => {
  const { operands, flags } = split(words, CURL_VALUE_FLAGS);
  for (const o of operands) add(out, o, program);
  for (const [flag, value] of flags) {
    if (value === undefined) continue;
    if (flag === "--url" || flag === "-x" || flag === "--proxy") {
      add(out, value, program);
    } else if (flag === "--resolve") {
      // host:port:address[,address]: both the name and the address are reached
      const [host, , addr] = value.replace(/^[+-]/, "").split(":");
      if (host) add(out, host, program);
      for (const a of (addr ?? "").split(",")) if (a) add(out, a, program);
    } else if (flag === "--connect-to") {
      // HOST1:PORT1:HOST2:PORT2
      const [h1, , h2] = value.split(":");
      for (const h of [h1, h2]) if (h) add(out, h, program);
    }
  }
};

const readWget: Reader = (words, program, out) => {
  const { operands, flags } = split(words, WGET_VALUE_FLAGS);
  for (const o of operands) add(out, o, program);
  for (const [flag, value] of flags) {
    if ((flag === "-e" || flag === "--execute") && value) {
      const m = /^(?:https?|ftp)_proxy\s*=\s*(.+)$/i.exec(value);
      if (m) add(out, m[1], program);
    }
  }
};

const readHttpie: Reader = (words, program, out) => {
  const { operands } = split(words, new Set());
  for (const o of operands) {
    // METHOD, key=value, Header:value and key:=json items are not destinations
    if (/^[A-Z]+$/.test(o) || /[=]/.test(o) || /^[\w-]+:[^/]/.test(o)) continue;
    add(out, o, program);
  }
};

const readPowerShellWeb: Reader = (words, program, out) => {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const m = /^-(\w+)(?::(.*))?$/.exec(w);
    if (m) {
      const name = m[1].toLowerCase();
      if (name === "uri" || name === "proxy") {
        const value = m[2] ?? words[i + 1];
        if (m[2] === undefined) i++;
        if (value) add(out, value, program);
      }
    } else if (w.includes("://")) {
      // The positional URI; a bare word could be a file name (-OutFile out.txt)
      add(out, w, program);
    }
  }
};

const readGit: Reader = (words, program, out) => {
  const sub = words.find((w) => !w.startsWith("-"));
  if (
    !sub ||
    ![
      "clone",
      "fetch",
      "pull",
      "push",
      "ls-remote",
      "remote",
      "submodule",
    ].includes(sub)
  ) {
    return;
  }
  for (const w of words.slice(words.indexOf(sub) + 1)) {
    if (w.startsWith("-")) continue;
    if (w.includes("://")) add(out, w, program);
    else add(out, w, program, parseScpStyle);
  }
};

const readSsh: Reader = (words, program, out) => {
  const { operands, flags } = split(words, SSH_VALUE_FLAGS);
  if (operands[0])
    add(out, operands[0], program, (w, p) => parseDestination(w, p));
  for (const [flag, value] of flags) {
    if (flag === "-J" && value)
      for (const j of value.split(",")) add(out, j, program);
  }
};

const readScp: Reader = (words, program, out) => {
  const { operands } = split(words, SSH_VALUE_FLAGS);
  for (const o of operands) {
    if (o.includes("://")) add(out, o, program);
    else add(out, o, program, parseScpStyle);
  }
};

const readNc: Reader = (words, program, out) => {
  const { operands } = split(words, NC_VALUE_FLAGS);
  if (operands[0]) add(out, operands[0], program);
};

const READERS: Record<string, Reader> = {
  curl: readCurl,
  wget: readWget,
  http: readHttpie,
  https: readHttpie,
  xh: readHttpie,
  "invoke-webrequest": readPowerShellWeb,
  "invoke-restmethod": readPowerShellWeb,
  git: readGit,
  ssh: readSsh,
  scp: readScp,
  rsync: readScp,
  sftp: readScp,
  nc: readNc,
  ncat: readNc,
  telnet: readNc,
};

const OPERATORS = new Set(["&&", "||", ";", "|", "&", "|&"]);

/** The program of a command word: no directory, no `.exe`, lower case, aliases resolved last. */
export function programName(word: string): string {
  const base = (word.split(/[\\/]/).pop() ?? word)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, "");
  return base in READERS ? base : (canonicalCmdlet(base) ?? base);
}

/**
 * The destinations of the commands in `command` (one entry of
 * `commandCandidates`, or any command text: pipelines and lists are read part
 * by part). Words are split on spaces, as the candidates are already
 * unquoted.
 */
export function destinationsOf(command: string): Destinations {
  const out: Destinations = { destinations: [], unresolved: [] };
  const words = command.trim().split(/\s+/).filter(Boolean);
  let segment: string[] = [];
  const flush = () => {
    // Skip `VAR=value` prefixes
    let i = 0;
    while (i < segment.length && /^[A-Za-z_]\w*=/.test(segment[i])) i++;
    const program = segment[i] ? programName(segment[i]) : undefined;
    const reader = program ? READERS[program] : undefined;
    if (program && reader) reader(segment.slice(i + 1), program, out);
    segment = [];
  };
  for (const w of words) {
    if (OPERATORS.has(w)) flush();
    else segment.push(w);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- named sets

function ipv4Value(dotted: string): number {
  return dotted.split(".").reduce((n, p) => n * 256 + Number(p), 0);
}

function inCidr(dotted: string, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return (
    Math.floor(ipv4Value(dotted) / size) === Math.floor(ipv4Value(base) / size)
  );
}

function isIPv4(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata.goog",
]);

/** The named sets a `net:` rule can use. */
export const NET_SETS = ["metadata", "local", "private"] as const;
export type NetSet = (typeof NET_SETS)[number];

export function isNetSet(name: string): name is NetSet {
  return (NET_SETS as readonly string[]).includes(name);
}

/** Whether a normalised host is in a named set. */
export function hostInNetSet(host: string, set: NetSet): boolean {
  switch (set) {
    case "metadata":
      return METADATA_HOSTS.has(host);
    case "local":
      return (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host === "::1" ||
        host === "::" ||
        host.startsWith("fe80:") ||
        (isIPv4(host) &&
          (inCidr(host, "127.0.0.0", 8) ||
            inCidr(host, "169.254.0.0", 16) ||
            host === "0.0.0.0"))
      );
    case "private":
      return (
        /^f[cd][0-9a-f]{2}:/.test(host) ||
        (isIPv4(host) &&
          (inCidr(host, "10.0.0.0", 8) ||
            inCidr(host, "172.16.0.0", 12) ||
            inCidr(host, "192.168.0.0", 16)))
      );
  }
}
