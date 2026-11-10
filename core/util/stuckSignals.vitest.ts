import { describe, expect, it } from "vitest";
import {
  callKey,
  detectStuck,
  errorSignature,
  nearKey,
  STUCK_THRESHOLDS,
  type StuckCall,
  type StuckSignalKind,
  type StuckStep,
} from "./stuckSignals";
import { buildWorkLog, formatWorkLog, shortCall } from "./workLog";

// ---------------------------------------------------------------------
// Builders

const call = (
  tool: string,
  args: Record<string, unknown> = {},
  more: Partial<StuckCall> = {},
): StuckCall => ({ tool, args, ...more });
const read = (path: string, extra: Record<string, unknown> = {}) =>
  call(
    "Read",
    { path, ...extra },
    { result: `content of ${path}`, read: [path] },
  );
const bash = (command: string, result = "ok", error = false) =>
  call("Bash", { command }, { result, error });
const edit = (path: string, hash: string) =>
  call(
    "Edit",
    { path },
    { result: "edited", changed: [{ path, hash }], read: [path] },
  );
const step = (...calls: StuckCall[]): StuckStep => ({ calls });
const say = (text: string): StuckStep => ({ text, calls: [] });
const kinds = (steps: StuckStep[]) =>
  detectStuck(steps).signals.map((s) => s.kind);

// ---------------------------------------------------------------------
// The corpus: small histories, each labelled

interface Case {
  name: string;
  steps: StuckStep[];
  /** What it is, and for a stuck one the signals that must fire */
  label: "stuck" | "healthy";
  expect?: StuckSignalKind[];
}

const FAIL = "FAIL: 3 tests failed";

const CORPUS: Case[] = [
  // ----- stuck
  {
    name: "the same Read with the same result four times",
    label: "stuck",
    expect: ["repeat-call"],
    steps: [
      step(read("a.ts")),
      step(read("a.ts")),
      step(read("a.ts")),
      step(read("a.ts")),
    ],
  },
  {
    name: "the same failing test run four times",
    label: "stuck",
    expect: ["repeat-call", "repeat-error", "retry-after-fail"],
    steps: [1, 2, 3, 4].map(() => step(bash("npm test", FAIL, true))),
  },
  {
    name: "a failing test with the flags shuffled and a number changed each time",
    label: "stuck",
    expect: ["near-repeat", "repeat-error"],
    steps: [
      step(bash("npm test --runInBand --bail 1", FAIL, true)),
      step(bash("npm test --bail --runInBand 2", FAIL, true)),
      step(bash("npm test --runInBand --bail 3", FAIL, true)),
      step(bash("npm test --bail --runInBand 4", FAIL, true)),
    ],
  },
  {
    name: "different commands hitting the same error",
    label: "stuck",
    expect: ["repeat-error"],
    steps: [
      step(bash("node a.js", "Error: Cannot find module '/x/y.js'", true)),
      step(bash("node b.js", "Error: Cannot find module '/p/q.js'", true)),
      step(bash("python c.py", "Error: Cannot find module '/m/n.js'", true)),
    ],
  },
  {
    name: "two calls alternating three times",
    label: "stuck",
    expect: ["ping-pong"],
    steps: [
      read("a.ts"),
      bash("ls", "a.ts b.ts"),
      read("a.ts"),
      bash("ls", "a.ts b.ts"),
      read("a.ts"),
      bash("ls", "a.ts b.ts"),
    ].map((c) => step(c)),
  },
  {
    name: "a file edited back and forth between two contents",
    label: "stuck",
    expect: ["edit-revert"],
    steps: ["h0", "h1", "h0", "h1", "h0"].map((h) => step(edit("f.ts", h))),
  },
  {
    name: "six steps of reading what was already read",
    label: "stuck",
    expect: ["no-progress"],
    steps: [
      step(read("a.ts")),
      step(read("b.ts")),
      ...["1-10", "11-20", "21-30", "31-40", "41-50", "51-60"].map((r) =>
        step(
          call(
            "Read",
            { path: "a.ts", range: r },
            { result: r, read: ["a.ts"] },
          ),
        ),
      ),
    ],
  },
  {
    name: "three messages in a row restating the plan",
    label: "stuck",
    expect: ["monologue"],
    steps: [
      step(read("a.ts")),
      say(
        "I will now look at the parser module and then update the tests for the parser module.",
      ),
      say(
        "I will now look at the parser module and then update the tests for the parser module now.",
      ),
      say(
        "I will look at the parser module and then update the tests for the parser module.",
      ),
    ],
  },
  {
    name: "the same program retried four times, failing differently each time",
    label: "stuck",
    expect: ["retry-after-fail"],
    steps: [
      step(bash("npm test src/a", "timeout waiting for server", true)),
      step(bash("npm test src/b", "assertion failed in suite", true)),
      step(bash("npm test src/c", "snapshot mismatch", true)),
      step(bash("npm test src/d", "network unreachable", true)),
    ],
  },

  // ----- healthy: repeating while the work changes, or not repeating
  {
    name: "a build re-run after each edit until it passes",
    label: "healthy",
    steps: [
      step(bash("npm run build", "type error in a.ts", true)),
      step(edit("a.ts", "h1")),
      step(bash("npm run build", "type error in a.ts", true)),
      step(edit("a.ts", "h2")),
      step(bash("npm run build", "type error in a.ts", true)),
      step(edit("a.ts", "h3")),
      step(bash("npm run build", "built")),
    ],
  },
  {
    name: "the third failing build, each separated by an edit",
    label: "healthy",
    steps: [
      step(bash("npm run build", "type error in a.ts", true)),
      step(edit("a.ts", "h1")),
      step(bash("npm run build", "type error in a.ts", true)),
      step(edit("a.ts", "h2")),
      step(bash("npm run build", "type error in a.ts", true)),
    ],
  },
  {
    name: "polling a job whose status changes",
    label: "healthy",
    steps: ["queued", "running 20%", "running 60%", "running 90%", "done"].map(
      (r) => step(call("Bash", { command: "gh run view 123" }, { result: r })),
    ),
  },
  {
    name: "reading five different files",
    label: "healthy",
    steps: ["a", "b", "c", "d", "e"].map((f) => step(read(`${f}.ts`))),
  },
  {
    name: "a test that fails, a fix, and a pass",
    label: "healthy",
    steps: [
      step(bash("npm test", FAIL, true)),
      step(edit("a.ts", "h1")),
      step(bash("npm test", "all passed")),
    ],
  },
  {
    name: "the same file read twice",
    label: "healthy",
    steps: [step(read("a.ts")), step(read("a.ts"))],
  },
  {
    name: "the same listing run four times with an edit between each",
    label: "healthy",
    steps: [
      step(bash("ls", "a.ts")),
      step(edit("a.ts", "h1")),
      step(bash("ls", "a.ts")),
      step(edit("b.ts", "h2")),
      step(bash("ls", "a.ts b.ts")),
      step(edit("c.ts", "h3")),
      step(bash("ls", "a.ts b.ts c.ts")),
    ],
  },
  {
    name: "a plain session: explain, read, edit, test",
    label: "healthy",
    steps: [
      say("I'll read the parser first."),
      step(read("parser.ts")),
      step(edit("parser.ts", "h1")),
      step(bash("npm test", "passed")),
      say("Done: the parser now handles empty input."),
    ],
  },
  {
    name: "a failing program retried across edits",
    label: "healthy",
    steps: [
      step(bash("npm test", "fail one", true)),
      step(edit("a.ts", "h1")),
      step(bash("npm test", "fail two", true)),
      step(edit("a.ts", "h2")),
      step(bash("npm test", "fail three", true)),
      step(edit("a.ts", "h3")),
      step(bash("npm test", "fail four", true)),
    ],
  },
];

describe("the corpus", () => {
  for (const c of CORPUS) {
    it(`${c.label}: ${c.name}`, () => {
      const report = detectStuck(c.steps);
      if (c.label === "healthy") {
        expect(report.signals, JSON.stringify(report.signals)).toEqual([]);
        expect(report.level).toBe("none");
      } else {
        for (const kind of c.expect ?? []) {
          expect(
            kinds(c.steps),
            `${kind} in ${JSON.stringify(report.signals)}`,
          ).toContain(kind);
        }
        expect(report.level).toBe("stuck");
      }
    });
  }

  it("has stuck and healthy cases for every signal, and more healthy than a signal alone", () => {
    const covered = new Set(CORPUS.flatMap((c) => c.expect ?? []));
    for (const kind of [
      "repeat-call",
      "near-repeat",
      "repeat-error",
      "ping-pong",
      "edit-revert",
      "no-progress",
      "monologue",
      "retry-after-fail",
    ] as const) {
      expect(covered.has(kind), kind).toBe(true);
    }
    expect(
      CORPUS.filter((c) => c.label === "healthy").length,
    ).toBeGreaterThanOrEqual(8);
  });
});

describe("levels", () => {
  it("a count below the first threshold is no signal; the first is a note", () => {
    expect(kinds([step(read("a.ts")), step(read("a.ts"))])).toEqual([]);
    const three = detectStuck([
      step(read("a.ts")),
      step(read("a.ts")),
      step(read("a.ts")),
    ]);
    expect(three.signals).toEqual([
      expect.objectContaining({ kind: "repeat-call", level: "note", count: 3 }),
    ]);
    expect(three.level).toBe("note");
  });

  it("two signals at note make it stuck", () => {
    const steps = [
      step(read("a.ts")),
      step(read("b.ts")),
      step(
        call(
          "Read",
          { path: "a.ts", part: "top" },
          { result: "t", read: ["a.ts"] },
        ),
      ),
      step(
        call(
          "Read",
          { path: "a.ts", part: "mid" },
          { result: "m", read: ["a.ts"] },
        ),
      ),
      step(
        call(
          "Read",
          { path: "a.ts", part: "end" },
          { result: "e", read: ["a.ts"] },
        ),
      ),
      step(
        call(
          "Read",
          { path: "a.ts", part: "top" },
          { result: "t", read: ["a.ts"] },
        ),
      ),
      step(
        call(
          "Read",
          { path: "a.ts", part: "top" },
          { result: "t", read: ["a.ts"] },
        ),
      ),
    ];
    const report = detectStuck(steps);
    expect(report.signals.map((s) => `${s.kind}:${s.level}`).sort()).toEqual([
      "no-progress:note",
      "repeat-call:note",
    ]);
    expect(report.level).toBe("stuck");
  });

  it("exports thresholds where the first is below the second", () => {
    for (const t of Object.values(STUCK_THRESHOLDS)) {
      expect(t.note).toBeLessThan(t.stuck);
    }
    // OpenHands's repeat counts are 3 and 4
    expect(STUCK_THRESHOLDS.repeatCall).toEqual({ note: 3, stuck: 4 });
  });

  it("an empty history and a history of text are not stuck", () => {
    expect(detectStuck([]).level).toBe("none");
    expect(detectStuck([say("hello")]).level).toBe("none");
  });
});

describe("keys", () => {
  it("callKey is the same for arguments in any order, and nearKey ignores case, spacing, numbers and flag order", () => {
    expect(callKey(call("T", { a: 1, b: 2 }))).toBe(
      callKey(call("T", { b: 2, a: 1 })),
    );
    expect(callKey(call("T", { a: 1 }))).not.toBe(callKey(call("T", { a: 2 })));
    expect(nearKey(call("Bash", { command: "npm  test --a --b 12" }))).toBe(
      nearKey(call("Bash", { command: "NPM test --b --a 99" })),
    );
    expect(nearKey(call("Bash", { command: "npm test" }))).not.toBe(
      nearKey(call("Bash", { command: "npm run build" })),
    );
  });

  it("errorSignature masks what varies and keeps the first line", () => {
    expect(
      errorSignature("ENOENT: no such file '/a/b/x.ts'\n  at foo (line 12)"),
    ).toBe(
      errorSignature("ENOENT: no such file '/c/d/y.ts'\n  at bar (line 99)"),
    );
    expect(errorSignature("Error 404 at 0xdeadbeef")).toBe("error # at <id>");
    expect(errorSignature("TypeError: x is not a function")).not.toBe(
      errorSignature("RangeError: out of range"),
    );
    expect(errorSignature(undefined)).toBe("");
  });
});

describe("the work log", () => {
  const steps: StuckStep[] = [
    say("Reading the parser."),
    step(read("parser.ts"), read("lexer.ts")),
    step(bash("npm test", "FAIL 2 tests in /repo/parser.test.ts", true)),
    step(edit("parser.ts", "h1")),
    step(bash("npm test", "all passed")),
  ];

  it("has one line per turn with the calls, files and error", () => {
    const log = buildWorkLog(steps);
    expect(log.map((e) => e.turn)).toEqual([1, 2, 3, 4, 5]);
    expect(log[0].line).toBe("1. said: Reading the parser.");
    expect(log[1].calls).toEqual(["Read parser.ts", "Read lexer.ts"]);
    expect(log[1].newReads).toEqual(["parser.ts", "lexer.ts"]);
    expect(log[2].error).toBe("fail # tests in <path>");
    expect(log[2].line).toContain("failed: fail # tests in <path>");
    expect(log[3].changed).toEqual(["parser.ts"]);
    // parser.ts was read before: the edit's read is not new
    expect(log[3].newReads).toEqual([]);
    expect(log[4].line).toBe("5. Bash npm test");
  });

  it("marks the signals active at the end of a turn", () => {
    const stuckSteps = [1, 2, 3, 4].map(() =>
      step(bash("npm test", FAIL, true)),
    );
    const log = buildWorkLog(stuckSteps);
    expect(log[0].signals).toEqual([]);
    expect(log[3].signals).toEqual(
      expect.arrayContaining(["repeat-call", "repeat-error"]),
    );
    expect(log[3].line).toContain("[");
    expect(buildWorkLog(stuckSteps, { signals: false })[3].signals).toEqual([]);
  });

  it("shortens a call to its tool and what it is about", () => {
    expect(shortCall(call("Edit", { path: "src/a.ts" }))).toBe("Edit src/a.ts");
    expect(
      shortCall(call("Bash", { command: "x".repeat(200) })).length,
    ).toBeLessThan(70);
    expect(shortCall(call("TaskList", { items: [] }))).toBe("TaskList");
  });

  it("formats the last turns and says how many it left out", () => {
    const log = buildWorkLog(
      Array.from({ length: 5 }, (_, i) => step(read(`f${i}.ts`))),
      {
        signals: false,
      },
    );
    const text = formatWorkLog(log, 2);
    expect(text.split("\n")).toEqual([
      "(3 earlier turns not shown)",
      "4. Read f3.ts · read f3.ts",
      "5. Read f4.ts · read f4.ts",
    ]);
    expect(formatWorkLog(log.slice(0, 1))).toBe("1. Read f0.ts · read f0.ts");
  });
});
