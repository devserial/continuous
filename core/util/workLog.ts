import {
  detectStuck,
  errorSignature,
  type StuckCall,
  type StuckSignalKind,
  type StuckStep,
} from "./stuckSignals";

/**
 * The work log (plans/stuck-detection.md, S0): one short line per turn,
 * derived from the same history the stuck signals read, so a person or a
 * check-in can see what was tried without scrolling. Nothing is written by the
 * model and nothing is stored: it is a view, rebuilt from the history.
 */
export interface WorkLogEntry {
  /** 1-based turn number */
  turn: number;
  /** The calls in short form: `Edit src/a.ts`, `Bash npm test` */
  calls: string[];
  /** Files changed in the turn */
  changed: string[];
  /** Files read for the first time in the turn */
  newReads: string[];
  /** The masked error text of the turn's first failure, if any */
  error?: string;
  /** The stuck signals active at the end of the turn */
  signals: StuckSignalKind[];
  /** The whole line */
  line: string;
}

const MAX_ARG = 60;

function clip(text: string, max = MAX_ARG): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** `Edit src/a.ts`, `Bash npm test`: the tool and what it was about. */
export function shortCall(call: StuckCall): string {
  const a = call.args ?? {};
  const target =
    a.path ??
    a.file ??
    a.filepath ??
    a.file_path ??
    a.command ??
    a.cmd ??
    a.query ??
    a.pattern ??
    a.url;
  return typeof target === "string"
    ? `${call.tool} ${clip(target)}`
    : call.tool;
}

/**
 * The log of a history: an entry per turn, with the signals active at the end
 * of that turn. Quadratic in the number of turns (each turn re-reads its
 * prefix), which is fine for the few hundred turns of a session; pass
 * `signals: false` to skip them.
 */
export function buildWorkLog(
  steps: StuckStep[],
  options: { signals?: boolean } = {},
): WorkLogEntry[] {
  const seenReads = new Set<string>();
  return steps.map((step, i) => {
    const calls = step.calls.map(shortCall);
    const changed = [
      ...new Set(
        step.calls.flatMap((c) => (c.changed ?? []).map((f) => f.path)),
      ),
    ];
    const newReads: string[] = [];
    for (const c of step.calls) {
      for (const r of c.read ?? []) {
        if (!seenReads.has(r)) {
          seenReads.add(r);
          newReads.push(r);
        }
      }
    }
    const failed = step.calls.find((c) => c.error);
    const error = failed ? errorSignature(failed.result) || "error" : undefined;
    const signals =
      options.signals === false
        ? []
        : [
            ...new Set(
              detectStuck(steps.slice(0, i + 1)).signals.map((s) => s.kind),
            ),
          ];

    const parts = [
      calls.length > 0
        ? calls.join("; ")
        : step.text
          ? `said: ${clip(step.text)}`
          : "no calls",
    ];
    if (error) parts.push(`failed: ${error}`);
    if (changed.length > 0) parts.push(`changed ${changed.join(", ")}`);
    if (newReads.length > 0) parts.push(`read ${newReads.join(", ")}`);
    if (signals.length > 0) parts.push(`[${signals.join(", ")}]`);
    return {
      turn: i + 1,
      calls,
      changed,
      newReads,
      ...(error ? { error } : {}),
      signals,
      line: `${i + 1}. ${parts.join(" · ")}`,
    };
  });
}

/** The log as text, the last `limit` turns when it is long. */
export function formatWorkLog(entries: WorkLogEntry[], limit = 20): string {
  const shown = entries.slice(-limit);
  const omitted = entries.length - shown.length;
  return [
    ...(omitted > 0
      ? [`(${omitted} earlier turn${omitted === 1 ? "" : "s"} not shown)`]
      : []),
    ...shown.map((e) => e.line),
  ].join("\n");
}
