/**
 * Stuck detection, the signals (plans/stuck-detection.md, S0): pure functions
 * over the history of tool calls that say whether an agent is going round in
 * circles, and how sure the signal is. Nothing here acts on the answer; the
 * notes, check-ins and escalation are later rows (S2 to S5).
 *
 * The input is deliberately small and host-free: a list of model turns, each
 * with the calls it made and what came back. The IDE (ChatHistoryItem with its
 * toolCallStates) and the CLI (the chat history behind repeatGuard.ts) each
 * adapt to it; neither is imported here.
 *
 * A signal is a count of how often something repeats, with two levels: `note`
 * (worth a line in the next tool result) and `stuck` (worth a check-in). The
 * thresholds start from OpenHands's stuck detector, which uses 3 to 4 repeats
 * (https://docs.openhands.dev/sdk/guides/agent-stuck-detector; its source was
 * read only through mirrors, so the figures are to be set from data in S1).
 *
 * What is not stuck: repeating something while the work changes. Every count
 * that is about a repeat is taken since the last file change, so a build that
 * is re-run after each edit, or a test that fails until the fix lands, starts
 * from zero each time.
 */

export interface StuckCall {
  /** The tool's name */
  tool: string;
  /** The arguments as sent */
  args?: Record<string, unknown>;
  /** What came back (the result text, or the error text) */
  result?: string;
  /** The call failed */
  error?: boolean;
  /** Files the call changed, with a hash of the content after (for edit-revert) */
  changed?: Array<{ path: string; hash: string }>;
  /** Files the call read */
  read?: string[];
}

/** One model turn: what it said and the calls it made. */
export interface StuckStep {
  text?: string;
  calls: StuckCall[];
}

export type StuckSignalKind =
  | "repeat-call"
  | "near-repeat"
  | "repeat-error"
  | "ping-pong"
  | "edit-revert"
  | "no-progress"
  | "monologue"
  | "retry-after-fail";

export type StuckLevel = "none" | "note" | "stuck";

export interface StuckSignal {
  kind: StuckSignalKind;
  level: "note" | "stuck";
  /** How often it repeated (calls, cycles, reverts or steps, by kind) */
  count: number;
  /** The normalised key that repeated: what the person or the log can show */
  key: string;
}

export interface StuckReport {
  signals: StuckSignal[];
  /** `stuck` if any signal is, or two are at `note` (the plan's second step) */
  level: StuckLevel;
}

interface Threshold {
  note: number;
  stuck: number;
}

/**
 * Where each signal reaches `note` and `stuck`. Exported so the host can show
 * them and S1 can change them; the units are in the comments.
 */
export const STUCK_THRESHOLDS = {
  /** the same call with the same result, since the last file change */
  repeatCall: { note: 3, stuck: 4 },
  /** calls that differ only in whitespace, case, numbers or flag order */
  nearRepeat: { note: 3, stuck: 4 },
  /** failures with the same masked error text */
  repeatError: { note: 2, stuck: 3 },
  /** cycles of two alternating calls */
  pingPong: { note: 2, stuck: 3 },
  /** times a file returned to content it already had */
  editRevert: { note: 1, stuck: 2 },
  /** steps in a row with calls but no change, no new file read, no new error */
  noProgress: { note: 4, stuck: 6 },
  /** text-only steps in a row that restate each other */
  monologue: { note: 2, stuck: 3 },
  /** failed attempts of the same program since the last file change */
  retryAfterFail: { note: 3, stuck: 4 },
} as const satisfies Record<string, Threshold>;

/** Word overlap at which two messages restate each other. */
export const MONOLOGUE_OVERLAP = 0.6;

/** The level a count reaches, or undefined below `note`. */
function levelOf(count: number, t: Threshold): "note" | "stuck" | undefined {
  if (count >= t.stuck) return "stuck";
  if (count >= t.note) return "note";
  return undefined;
}

// ----------------------------------------------------------------------
// Keys

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** The exact key of a call: its tool and its arguments as canonical JSON. */
export function callKey(call: Pick<StuckCall, "tool" | "args">): string {
  return `${call.tool} ${canonical(call.args ?? {})}`;
}

function nearString(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/\d+/g, "#")
    .split(/\s+/)
    .filter(Boolean);
  // Flag order is not meaning: sort the flags, keep the words in place
  const flags = tokens.filter((t) => t.startsWith("-")).sort();
  let f = 0;
  return tokens.map((t) => (t.startsWith("-") ? flags[f++] : t)).join(" ");
}

function nearValue(value: unknown): unknown {
  if (typeof value === "string") return nearString(value);
  if (Array.isArray(value)) return value.map(nearValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        nearValue(v),
      ]),
    );
  }
  return value;
}

/**
 * A call's key with the differences that are not a different call taken out:
 * case, spacing, numbers (a port, a line, a count) and the order of flags.
 */
export function nearKey(call: Pick<StuckCall, "tool" | "args">): string {
  return `${call.tool.toLowerCase()} ${canonical(nearValue(call.args ?? {}))}`;
}

/**
 * An error text with what varies from run to run masked (paths, numbers,
 * hex ids, quoted names), first line only, so "ENOENT '/a/x.ts'" and
 * "ENOENT '/b/y.ts'" are one error.
 */
export function errorSignature(text: string | undefined): string {
  const first =
    (text ?? "").split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return first
    .toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][\w@.\-\\/]+/g, "<path>")
    .replace(
      /\b[\w-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|md|json|ya?ml)\b/g,
      "<file>",
    )
    .replace(/0x[0-9a-f]+|\b[0-9a-f]{7,}\b/g, "<id>")
    .replace(/(["'`]).*?\1/g, "<q>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** The program a call runs: the tool, and for a command its first word or two. */
function programKey(call: StuckCall): string {
  const command = call.args?.command ?? call.args?.cmd;
  if (typeof command === "string") {
    const words = command.trim().split(/\s+/).slice(0, 2);
    return `${call.tool.toLowerCase()} ${words.join(" ").toLowerCase()}`;
  }
  return call.tool.toLowerCase();
}

// ----------------------------------------------------------------------
// Signals

interface Flat {
  /** Index of the step the call is in */
  step: number;
  call: StuckCall;
}

function flatten(steps: StuckStep[]): Flat[] {
  return steps.flatMap((s, step) => s.calls.map((call) => ({ step, call })));
}

/** Index of the last step that changed a file, or -1. */
function lastChange(steps: StuckStep[]): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].calls.some((c) => c.changed?.length)) return i;
  }
  return -1;
}

function add(
  out: StuckSignal[],
  kind: StuckSignalKind,
  count: number,
  key: string,
  t: Threshold,
): void {
  const level = levelOf(count, t);
  if (level) out.push({ kind, level, count, key });
}

function repeats(epoch: Flat[], out: StuckSignal[]): void {
  const last = epoch.at(-1);
  if (!last) return;

  // The same call, with the same result: an action and its observation
  const exact = callKey(last.call);
  const observation = (last.call.result ?? "").trim();
  const same = epoch.filter(
    (f) =>
      callKey(f.call) === exact && (f.call.result ?? "").trim() === observation,
  );
  add(out, "repeat-call", same.length, exact, STUCK_THRESHOLDS.repeatCall);

  // Calls that differ only in spacing, numbers or flag order
  const near = nearKey(last.call);
  const nearSame = epoch.filter((f) => nearKey(f.call) === near);
  if (new Set(nearSame.map((f) => callKey(f.call))).size > 1) {
    add(out, "near-repeat", nearSame.length, near, STUCK_THRESHOLDS.nearRepeat);
  }

  // Failures with the same masked error, whatever the calls were
  if (last.call.error) {
    const sig = errorSignature(last.call.result);
    const sameError = epoch.filter(
      (f) => f.call.error && errorSignature(f.call.result) === sig,
    );
    add(
      out,
      "repeat-error",
      sameError.length,
      sig,
      STUCK_THRESHOLDS.repeatError,
    );
  }

  // The same program tried again and again, each time failing
  const program = programKey(last.call);
  const attempts = epoch.filter((f) => programKey(f.call) === program);
  const allFailed = attempts.length > 0 && attempts.every((f) => f.call.error);
  if (last.call.error && allFailed) {
    add(
      out,
      "retry-after-fail",
      attempts.length,
      program,
      STUCK_THRESHOLDS.retryAfterFail,
    );
  }
}

/** A, B, A, B, ...: cycles of two different calls at the end of the history. */
function pingPong(flat: Flat[], out: StuckSignal[]): void {
  // A call that wrote new content is not the same call as before, so edits
  // that move the work forward do not alternate with a build as a ping-pong
  const keys = flat.map(
    (f) =>
      `${callKey(f.call)}=>${(f.call.result ?? "").trim()}@${(
        f.call.changed ?? []
      )
        .map((c) => `${c.path}:${c.hash}`)
        .join(",")}`,
  );
  const n = keys.length;
  if (n < 4) return;
  const a = keys[n - 2];
  const b = keys[n - 1];
  if (a === b) return;
  let length = 0;
  for (let i = n - 1; i >= 1 && keys[i] === b && keys[i - 1] === a; i -= 2) {
    length += 2;
  }
  add(
    out,
    "ping-pong",
    Math.floor(length / 2),
    `${a} <-> ${b}`,
    STUCK_THRESHOLDS.pingPong,
  );
}

/** A file whose content comes back to a hash it already had. */
function editRevert(steps: StuckStep[], out: StuckSignal[]): void {
  const history = new Map<string, string[]>();
  for (const step of steps) {
    for (const call of step.calls) {
      for (const c of call.changed ?? []) {
        const list = history.get(c.path) ?? [];
        if (list.at(-1) !== c.hash) list.push(c.hash);
        history.set(c.path, list);
      }
    }
  }
  for (const [path, hashes] of history) {
    let reverts = 0;
    for (let i = 2; i < hashes.length; i++) {
      if (hashes.slice(0, i - 1).includes(hashes[i])) reverts++;
    }
    add(out, "edit-revert", reverts, path, STUCK_THRESHOLDS.editRevert);
  }
}

/** Steps at the end with calls but no change, no new file read, no new error and no answer that changed. */
function noProgress(steps: StuckStep[], out: StuckSignal[]): void {
  const seenReads = new Set<string>();
  const seenErrors = new Set<string>();
  // The last result of each call: the same call answering differently (a job
  // that moves from queued to running) is the world changing, not a loop
  const lastResult = new Map<string, string>();
  let run = 0;
  for (const step of steps) {
    let progress = false;
    for (const call of step.calls) {
      if (call.changed?.length) progress = true;
      const key = callKey(call);
      const result = (call.result ?? "").trim();
      if (lastResult.has(key) && lastResult.get(key) !== result)
        progress = true;
      lastResult.set(key, result);
      for (const r of call.read ?? []) {
        if (!seenReads.has(r)) {
          seenReads.add(r);
          progress = true;
        }
      }
      if (call.error) {
        const sig = errorSignature(call.result);
        if (!seenErrors.has(sig)) {
          seenErrors.add(sig);
          progress = true;
        }
      }
    }
    if (step.calls.length === 0) continue;
    run = progress ? 0 : run + 1;
  }
  add(
    out,
    "no-progress",
    run,
    "no change, no new file, no new error",
    STUCK_THRESHOLDS.noProgress,
  );
}

function shingles(text: string): Set<string> {
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  return new Set(
    words.length < 3
      ? words
      : words.slice(2).map((_, i) => words.slice(i, i + 3).join(" ")),
  );
}

function overlap(a: string, b: string): number {
  const x = shingles(a);
  const y = shingles(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const s of x) if (y.has(s)) both++;
  return both / (x.size + y.size - both);
}

/** Text-only steps at the end that restate each other. */
function monologue(steps: StuckStep[], out: StuckSignal[]): void {
  const tail: string[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.calls.length > 0 || !s.text?.trim()) break;
    tail.unshift(s.text);
  }
  let run = 0;
  for (let i = tail.length - 1; i >= 1; i--) {
    if (overlap(tail[i], tail[i - 1]) >= MONOLOGUE_OVERLAP) run++;
    else break;
  }
  // N restatements are N + 1 messages
  add(
    out,
    "monologue",
    run > 0 ? run + 1 : 0,
    tail.at(-1)?.slice(0, 60) ?? "",
    STUCK_THRESHOLDS.monologue,
  );
}

/**
 * Reads the end of a history. Signals about repeats count only since the last
 * file change; ping-pong, edit-revert, no-progress and monologue look at the
 * whole run. Cheap: one pass per signal over the calls.
 */
export function detectStuck(steps: StuckStep[]): StuckReport {
  const signals: StuckSignal[] = [];
  const flat = flatten(steps);
  const changedAt = lastChange(steps);
  repeats(
    flat.filter((f) => f.step > changedAt),
    signals,
  );
  pingPong(flat, signals);
  editRevert(steps, signals);
  noProgress(steps, signals);
  monologue(steps, signals);

  const stuck =
    signals.some((s) => s.level === "stuck") ||
    signals.filter((s) => s.level === "note").length >= 2;
  return {
    signals,
    level: stuck ? "stuck" : signals.length > 0 ? "note" : "none",
  };
}
