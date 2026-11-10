# Stuck detection

Status: plan, 2026-11-09. Nothing new is built; one piece exists (the repeated-call guard). Roadmap row: Track S. Related: Loop mode's no-progress and failure limits (`loop-mode.md`), M3 escalation (Track M), the toolbox drawer (#379, `core/util/toolboxCards.ts`), compaction (Track C).

## Why

An agent that is stuck keeps spending: it re-runs a failing command with small variations, edits a file and undoes the edit, reads the same files again, or restates the same plan. The person sees it only by watching. In a loop or a headless run nobody is watching, and the budgets (rounds, tokens, time) are the only stop, so the cost of being stuck is the whole budget.

What exists today is narrow:

- **Identical calls.** `refuseRepeatedCalls` and `repeatGuard.ts` in the CLI refuse a call identical to earlier ones, and `LOOP_REPEAT_LIMIT = 4` in `core/util/loopMode.ts` does the same inside a loop item (the code comment cites OpenHands' stuck detector).
- **Loop stops.** Loop mode stops on no progress and on repeated failures, and holds an item that ended stuck (H11).
- **Escalation** to the `replan` model on stuck detection is planned (M3) but has no detector behind it beyond the above.
- **The toolbox** has pre-canned problem-solving prompts a person can send by hand, and nothing offers them when the agent is stuck.

What is missing: detection of the many ways to repeat that are not byte-identical; a record of what was tried that a person or a reviewer can read; and guidance that the agent or the person can act on ("you appear stuck; try this").

## What others do

Read on 2026-11-09. The OpenHands source copies found were unofficial mirrors, so the thresholds below are from its documentation page and should be checked against the current source.

| Project                                                                                | Patterns and responses                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [OpenHands stuck detector](https://docs.openhands.dev/sdk/guides/agent-stuck-detector) | Five patterns checked over the history since the last user message: the same action and observation 4 or more times; the same action ending in an error 3 or more times; a monologue of 3 or more agent messages with no progress; an alternating ping-pong between two action and observation pairs (6 cycles in the docs, a six-step window in older code); and repeated context-window errors |
| Pydantic AI loop detection                                                             | Named patterns with thresholds: the same call in a window (default 5), identical results, repeated text responses                                                                                                                                                                                                                                                                                |
| Koda (a Rust agent)                                                                    | Feedback injected on the first detection, a hard stop only on the second, when the model ignored the feedback                                                                                                                                                                                                                                                                                    |
| Calute, AG2                                                                            | Warning and critical thresholds for same-call repetition and ping-pong alternation, and a cap on tool calls per turn; AG2 only warns                                                                                                                                                                                                                                                             |

The shared shape: detect cheaply from the call history, tell the agent first, stop only if it carries on. This plan follows that, and adds the two things the owner asked for: a readable log, and a way-out suggestion drawn from the toolbox.

## Design

### Signals (cheap, local, no model)

Computed per session from the tool-call history, each with a normalised key so small variations still match:

| Signal             | Detects                                                                                                      | Key                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `repeat-call`      | The same tool with the same arguments (exists)                                                               | tool + canonical arguments                                  |
| `near-repeat`      | The same tool with arguments that differ only in whitespace, quoting, flag order or a trailing number        | tool + arguments with those normalised                      |
| `repeat-error`     | Different calls that fail with the same error text (a test with a new flag each time, a path that is wrong)  | error text with paths, numbers and timestamps masked        |
| `ping-pong`        | A, B, A, B over three or more cycles: edit then revert, run then undo                                        | the sequence of call keys                                   |
| `edit-revert`      | A file whose content returns to a hash it already had                                                        | per-file content hashes after each write                    |
| `no-progress`      | N turns with no file change, no new file read and no new error, only reads of known files or the same search | the set of files read and changed since the last change     |
| `monologue`        | Consecutive assistant messages that restate (high word overlap) with no tool call between                    | shingled word overlap of messages                           |
| `retry-after-fail` | The same command retried with a variation after a failure, three or more times                               | the command's program and subcommand, with arguments masked |

Each signal has a count and a level: `note` at the first threshold, `stuck` at the second. Thresholds start from the OpenHands values (3 to 4) and are set from data in S1.

Legitimate repetition must not trip it: polling a build or a test run while changing code between runs is progress, so a signal resets on a file change and `repeat-error` counts only runs with no change in between (the rule the repeated-call message already uses).

### The work log

Derived mechanically from the same history, kept with the session, not sent to the model unless a check-in needs it. One line per turn: the turn number, the tool calls in short form (`Edit src/a.ts`, `Bash npm test → exit 1: 3 failing`), files changed, files first read, the error signature if any, and which signals were active. A rolling summary every N turns keeps it short.

It earns its place three ways, and the first needs no model: (a) the check-in below uses it as the "what was tried" record; (b) compaction and the "new session with this plan" action (F5) can start from it; (c) a person can read it ("Work log" in the session menu) to see what the agent did without scrolling. If S1 shows the signals work without it, it stays small and optional; it is not a prerequisite.

### The ladder

| Level | When                                               | What happens                                                                                                                                                                                                                                                                                                         |
| ----- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1    | A signal reaches `note`                            | A one-line note appended to the **tool result** of the call that tripped it ("this is the 3rd run of a test that fails with the same error; no file changed in between"). Nothing in the system prompt changes, so the cache holds                                                                                   |
| L2    | A signal reaches `stuck`, or two signals at `note` | A **check-in**: the next request carries a short system-style message with the work log and a guidance line chosen from the signal ("If you are stuck: state in one sentence what you expect, what you see, and the smallest experiment that would tell them apart"), and asks for a change of approach, not a retry |
| L3    | The agent carries on after L2                      | Escalate once: run the next attempt on the `replan` model (M3), or, in a loop, hold the item (H11 already does for stuck items)                                                                                                                                                                                      |
| L4    | L3 did not help                                    | Stop and report: what was tried (the log), what the signals were, and what the person could try. In the IDE this is a message and a chip; headless it is the end-of-run report                                                                                                                                       |

Guidance comes from a small table that maps a signal to a toolbox card, so the advice is the owner's own method and not a model's improvisation:

| Signal                             | Suggested toolbox move (group)                                           |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `repeat-error`, `retry-after-fail` | Diagnose: reproduce it smaller, or state the expected against the actual |
| `ping-pong`, `edit-revert`         | Decide: list the two approaches and what each breaks, then pick one      |
| `no-progress`, `monologue`         | Understand: restate the goal and the next concrete step                  |
| `repeat-call`                      | Check: the call's last result is above; what would be different now?     |

For a person watching, the same table drives a **chip** in the chat ("Looks stuck: the same test failed 3 times") with a button that opens the toolbox drawer on that card, ready to insert or send. For the agent, the card's text is the guidance line at L2. One source of wording, two readers.

### Where it runs

- Core owns the signals and the log (pure functions over the history, tested), so the IDE and the CLI share them. The CLI's `repeatGuard.ts` becomes the `repeat-call` signal and keeps its refusal behaviour.
- The CLI and `cn serve` apply L1 to L4. The IDE applies L1 and L2 and shows the chip; L3 uses the same model switch as M3.
- Loop mode reads the signals instead of its own counters where it can, so one definition of stuck serves chat and loop.

### Cost and the cache

L1 appends to a tool result and L2 adds one message; neither touches the system prompt or earlier messages, so the prefix stays valid (the rule the cache work uses: C8, C44, C50). A check-in costs one request's worth of input and is measured in S1.

## Build order

| #   | Scope                                                                                                                                                                                           | Done when                                                                                                               | State                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0  | The signals as pure functions in core with a corpus of recorded histories (stuck and not stuck), and the work log as a derived view. No behaviour change                                        | Each signal fires on its stuck cases and stays quiet on the legitimate-repetition cases in the corpus                   | Built (#414, `core/util/stuckSignals.ts`, `workLog.ts`): the eight signals as pure functions with exported thresholds, a derived work log, and a labelled corpus of 18 histories; the host adapters, measurement (S1) and any use of the signals are not built |
| S1  | Measure on real data: run S0 over the dev data and bench runs we have (the Nova, Qwen, Kimi and DeepSeek loop runs), record fire rate, lead time before the budget ran out, and false positives | A table per signal; thresholds set from it; a signal that fires on more than 5% of healthy runs is dropped or tightened | Not started                                                                                                                                                                                                                                                    |
| S2  | L1 notes in tool results (CLI and IDE), the CLI repeat guard moved onto the shared signal                                                                                                       | A stuck bench scenario shows the note and a changed next call at least as often as no note; no change in healthy runs   | Not started                                                                                                                                                                                                                                                    |
| S3  | L2 check-in with the work log and the guidance table; a bench scenario that cannot be solved the way the agent starts (a wrong path, a flaky test, an impossible check)                         | Recovery rate with the check-in against without, n=5 per model; cost of the extra request recorded                      | Not started                                                                                                                                                                                                                                                    |
| S4  | The chip in the IDE with a button into the toolbox card, and the "Work log" view                                                                                                                | The chip appears on a real stuck session, the card opens, the log reads                                                 | Not started                                                                                                                                                                                                                                                    |
| S5  | L3 and L4: escalation through M3, the stop report with the log, and loop mode on the shared signals                                                                                             | A loop item that stays stuck escalates once, then ends with a report naming the signals and what was tried              | Not started                                                                                                                                                                                                                                                    |
| S6  | Settings: `stuckDetection:` with `off`, `notes` and `full`, per-signal thresholds, and a docs page                                                                                              | A person can turn the check-ins off and keep the notes                                                                  | Not started                                                                                                                                                                                                                                                    |

## Decisions for the owner

| #   | Decision                | Options and a recommendation                                                                                                                                                                                                                                 |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Is the work log needed? | Build the signals first (S0) and the log as a derived view of the same history (recommended). It costs little and serves the check-in, compaction and the person. Do not make the model write it: that is more tokens spent on the thing that is going wrong |
| D2  | A model review at L2    | Start without one: the check-in is the log plus a fixed guidance line. A review by the `reviewer` model ("what has been tried and why is it failing") is a later step, measured against the plain check-in in S3                                             |
| D3  | Default level           | Notes on, check-ins on in loops and headless runs, chip only in the IDE (recommended). Interactive chat gets the chip, not an injected message, because the person is there to choose                                                                        |
| D4  | Hard stop               | Only after L2 was ignored (the Koda rule), and never on `repeat-call` alone below the existing limit                                                                                                                                                         |

## Out of scope

- Judging whether the agent's reasoning is right. This reads the call history, not the content of its thinking.
- Killing a command that hangs; that is the terminal tool's timeout.
- A general memory or notes feature for the agent (Track F covers the plan list; the work log is read-only and derived).
