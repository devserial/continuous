# Loop budgets and their controls

Status: plan, 2026-11-09. Roadmap row: Track T. Builds on Loop mode (`loop-mode.md`), the usage and cost ledger (Track C, `calculateRequestCost`) and stuck detection (`stuck-detection.md`).

## Why

A loop stops on a budget, so the budget is what the person is really choosing when they start one. Today (`LoopBudget` in `core/index.d.ts`, `DEFAULT_LOOP_BUDGET` in `core/util/loopMode.ts`) the budgets are:

| Budget                   | Field                    | Default    | Where it is editable                          |
| ------------------------ | ------------------------ | ---------- | --------------------------------------------- |
| Rounds (re-plans)        | `maxRounds`              | 5          | Loop controls in the IDE, while the loop runs |
| Tokens (prompt + output) | `maxTokens`              | 10,000,000 | the same                                      |
| Wall time                | `maxWallMs`              | 2 hours    | the same, in minutes                          |
| Attempts per item        | `maxAttempts`            | 2          | not in the UI                                 |
| No-progress rounds       | `maxNoProgressRounds`    | 2          | not in the UI                                 |
| Consecutive failures     | `maxConsecutiveFailures` | 3          | not in the UI                                 |
| Turns per item           | `maxItemTurns`           | 60         | not in the UI                                 |

Gaps:

- **No cost budget.** The question a person asks is "how much may this spend", and tokens are a poor proxy: a million cached input tokens and a million fresh output tokens differ by an order of magnitude in price, and across models by more. The ledger already prices every request (cache reads, writes, regional premium, per model), so a dollar limit is computable.
- **The budgets are fields, not a strategy.** Three autonomy levels (Supervised, Auto, Unattended) each carry a preset, but a person cannot say "stop at five dollars", "ten turns per item", or "one hour, whatever it costs" without editing numbers one at a time, and cannot see how close each is.
- **Counting differs by budget.** Tokens count output plus input the provider did not cache (`loopMode.ts`), rounds count re-plans, turns count model calls. A person cannot tell from the UI which counter will fire first.
- **A limit stops the loop; nothing warns before it.** There is no "80% of the cost budget used" moment to extend or wrap up.

## Design

### Four budget kinds, one control

| Kind       | Unit        | Counts                                                                                           | Stops at                                                                               |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Cost**   | USD         | The ledger's price of each request in the loop, per model (new)                                  | Over the limit; an unpriced model is shown as unknown and cannot be capped (see below) |
| **Turns**  | model calls | Calls across the loop, and per item (`maxItemTurns`)                                             | Per-loop and per-item limits                                                           |
| **Tokens** | tokens      | Output plus input not read from the cache (today's rule), with the cached share shown separately | Over the limit                                                                         |
| **Time**   | minutes     | Wall time of the loop, not counting time waiting for the person (an inbox question, an approval) | Over the limit                                                                         |

A budget set to zero means no limit, as today. A loop may use any combination; the first to be reached stops it, and the reason is named ("Cost budget: $5.02 of $5.00"). Rounds, attempts, no-progress and failures stay as the loop's own safety limits and move under "Safety limits" in the control.

**Unpriced models.** A model with no price in the shared table (a local server, a new model) has no dollar figure. A cost budget then cannot be enforced; the control says so and offers a token or turn budget instead, and the loop never treats the unknown as zero.

### The control

One panel, in the loop controls and in the settings for a loop's defaults:

- A row per kind with a switch, a number and a unit, and a live meter ("$1.84 of $5.00", "212 of 600 turns", "1.2M of 10M tokens", "41 of 120 min"). The meter shows which will fire first.
- A **preset** menu that fills the rows: Frugal, Balanced, Thorough, Unlimited, and the autonomy levels' own, so the existing three levels map onto it. A person can save their own.
- A **per-item** line: turns and, when cost is set, a share of the cost an item may take, so one runaway item cannot use the whole budget.
- **Thresholds**: a warning at 80% (a note in the inbox and the strip), and what happens at the limit: stop, or ask ("The loop has used its cost budget. Add $2, or stop?"), chosen per loop and defaulting to ask when a person is watching and stop when not.
- **Change while running** for every row, as the three editable budgets are today, with the same rule that a change takes effect at the next check.

The CLI gets the same through flags and `cn serve` through the `/state` snapshot and a `loopBudget` message: `--max-cost 5`, `--max-turns 600`, `--max-tokens 10m`, `--max-minutes 120`.

### Where the numbers come from

- **Cost** from the usage ledger: a per-loop running total, summed when each request completes. The ledger's lookup already applies cache reads and writes and the regional premium, so the loop does not price anything itself. The total is an estimate and is labelled so.
- **Turns** from the loop driver's own count (it already counts item turns).
- **Tokens and time** as now.

### Interaction with other tracks

- Stuck detection (Track S) is a different stop: it stops waste inside the budget; the budget stops the whole.
- M3 escalation to a stronger model raises the price per turn; the cost meter makes that visible, and a cost budget bounds it.
- Parallel waves (Track N) spend faster; budgets are shared across workers, and a wave refuses to start when fewer than one item's share remains.

## Built so far (2026-11-09)

The control starts out of the way: the limits (rounds, tokens, minutes) are hidden behind **Set a budget** on the Re-plan row, and **Apply** closes them. Once a budget has been set, or differs from its level's own, the loop controls show what the loop has used and what is left: one meter each for rounds, tokens and time (the bar turns amber from 80% and red at the limit; a limit of 0 shows what has been used instead), the items done, the runs so far, and the runs per task. The clock ticks every 30 seconds while the loop runs. The numbers come from `core/util/loopUsage.ts`, a pure function over the loop state, the session's token total and the time, so the CLI strip can use it too.

Per task: each item records the tokens and time its runs used (`LoopItemState.usage`, counted from the session's token total at the run's start, or from the worker's own usage; the IDE's workers record time only) and the task row shows "2 runs · 14K tokens · 6m".

Not yet: cost and turns (the loop does not count them), the limits themselves per item (T5's `budget:` line and enforcement), and a stop-or-ask when a limit is reached (T8).

## Budgets per task

Added 2026-11-09 from the owner: apply the same budgets to each to-do, so one item cannot swallow the loop; decide what happens when an item's budget runs out; and offer a budget step when the loop is entered, with strategies for dividing the loop's budget among its items.

Today an item has one limit, `maxItemTurns` (60), and attempts (`maxAttempts`). Nothing bounds an item's tokens, cost or time, so a single stuck item can use the whole loop's budget before the loop-level stop fires, and the loop learns of it only when the loop is over.

### An item's budget

The same four kinds as the loop (cost, turns, tokens, time) on each to-do, optional, each at zero meaning no limit. Set in three places, in this order of precedence: the person's edit on the plan card or in the inbox, a `budget:` line under the to-do in the plan file (beside `after:`, `check:`, `model:` and `files:`), and the loop's division strategy (below).

```markdown
- [ ] Add retry with backoff to the sync client
      check: npm test -- retry
      model: Claude Sonnet
      budget: 25 turns, $0.60, 20 min
```

An item's numbers always sit inside the loop's: an item whose budget exceeds what the loop has left is capped at what is left, and the plan card says so.

### Dividing the loop's budget

A strategy turns the loop's budget into a budget for each item at the start, and again at every re-plan from what is left. The person picks one on the plan card; Loop's autonomy level has a default.

| Strategy                       | How an item's budget is set                                                                                                                                                        | Good for                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Equal**                      | The loop's budget divided by the number of items                                                                                                                                   | Items of similar size                                          |
| **Weighted**                   | Divided by a weight per item: a `size: S, M, L` or `weight: 3` line in the plan (the planner proposes it, the person edits it)                                                     | Plans with a few large items among small ones                  |
| **Fair share of what is left** | Each item may use up to a share (say a third, or 1 divided by items left, whichever is larger) of what remains when it starts, so the unused part of a finished item rolls forward | Unknown sizes; unused budget is never wasted                   |
| **Reserve**                    | A fraction (default 20%) is held back from the split and spent only on extensions, re-plans and a final check                                                                      | Any strategy; the safety margin that makes a limit bearable    |
| **None**                       | No per-item budget except the `maxItemTurns` limit and any `budget:` line                                                                                                          | Today's behaviour; the default until the strategies are tested |

Strategies combine: a split (equal, weighted or fair share) plus a reserve.

### Entering the loop

The plan turn is where the budget is decided, because the plan is where sizes become known. When a plan is presented in Loop, the plan card gains a **Budget** step before **Build in a loop**:

- The loop's budget from the control (T1), a strategy menu, and the resulting number beside each to-do, editable in place.
- A **proposal**: an estimate for each item from past runs, taken from the usage ledger (the median turns, tokens and cost of finished items on the same model, scaled by the `size:` line). It says "no history" for a model with none rather than guessing.
- Who may set it follows the **Plan edits** level (policy areas): at Manual the person sets and approves every budget; at Cautious the planner's proposal stands unless the person changes it; at Permissive and above the planner's budgets apply, within the loop's total; at Automatic the reviewer may adjust them. The plan turn may only propose budgets inside what the loop allows.
- **Skip** leaves the strategy at None, so entering a loop stays one click.

### When an item's budget runs out

Three steps, none of them a surprise:

1. **A note at 80%** appended to the next tool result (the cache-safe route of the stuck-detection plan): "this item has used 80% of its turns; finish it, or say what is left and call `finish_item` with outcome `later`."
2. **At 100% the item stops at the next turn boundary** with the outcome `over_budget`, distinct from `failed`: the work so far is kept, and the report says which budget ran out and what the item had done (the work log of Track S, when built).
3. **What follows is a policy decision**, by autonomy level:

| Level          | At the limit                                                                                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Supervised** | The inbox asks: extend (by a stated amount, from the reserve), split the item (re-plan it into smaller to-dos), skip it, or mark it blocked                                                                                                                                                                                           |
| **Auto**       | **A review** decides: a reviewer model (or the `replan` model) reads the item's work log and the stuck signals and answers one of extend, split or stop. An extension is allowed only if the item is progressing (files changed, a check moved toward passing, no stuck signal), at most once, and at most a set share of the reserve |
| **Unattended** | No extension unless the strategy says so; the item ends `over_budget` and the loop's strategy runs: a re-plan that sees the item's findings and the budget it used, so it can split the work or change the approach                                                                                                                   |

The person can force either side: **Suggest** (always ask), **Force** (always stop) or **Review** (the table above), in the loop's settings.

An extension is drawn from the reserve and counted against the loop's total; an item with no reserve left cannot be extended, so the loop's budget stays a real ceiling.

### Where the signals come from

- Cost, turns, tokens and time per item from the same counters as the loop's, kept per item (the driver already counts item turns; the ledger prices requests).
- Progress for the review from the stuck-detection signals (Track S): file changes since the last check, `repeat-error` counts, `no-progress` and the check's last result. A budget expiry and a stuck signal on the same item is the clearest case for stopping.

## Build order

| #   | Scope                                                                                                                                                                                                                                                                                | Done when                                                                                                                    | State                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0  | `maxCostUsd` and a per-loop cost total from the ledger in core; `budgetStop` names the budget and the figures; a priced-model check; tests with a scripted ledger                                                                                                                    | A loop with a $1 budget stops after the request that crosses it, naming cost; an unpriced model is refused for a cost budget | Not started                                                                                                                                                                                                                                                                                                 |
| T1  | The control in the IDE: rows with live meters, the 80% note, stop or ask at the limit, all editable while running                                                                                                                                                                    | A person can set and change all four kinds and see which will fire first                                                     | Partly built: the limits sit behind a **Set a budget** button (nothing shows until asked), and after a budget is set the loop controls show what is left of rounds, tokens and time as meters (warning from 80%) with the totals; cost and turns are not metered yet, and there is no per-limit stop or ask |
| T2  | Presets (Frugal, Balanced, Thorough, Unlimited) mapped to the autonomy levels, savable; per-item limits (turns, cost share)                                                                                                                                                          | The three autonomy levels read as presets in the panel with no change in behaviour                                           | Not started                                                                                                                                                                                                                                                                                                 |
| T3  | The CLI and `cn serve`: flags, the `/state` snapshot fields, the budget message and the end-of-run report naming the budget that stopped the run                                                                                                                                     | A headless run stops on `--max-cost` and the report says so                                                                  | Not started                                                                                                                                                                                                                                                                                                 |
| T4  | Wave-aware budgets for parallel workers, and a settings page for the defaults; docs                                                                                                                                                                                                  | Two workers share one budget; the docs page lists every flag and field                                                       | Not started                                                                                                                                                                                                                                                                                                 |
| T5  | Item budgets in core: cost, turns, tokens and time on a to-do, a `budget:` line in the plan file, enforcement at the turn boundary, the 80% note, and the outcome `over_budget` (distinct from `failed`) with a report of what ran out                                               | T0                                                                                                                           | A to-do with `budget: 10 turns` stops after its tenth turn with `over_budget`, keeps its work, and the loop goes on; the 80% note appears in the tool result                                                                                                                                                | Built (#417): the `budget:` line, `over_budget` ends a run with its work kept, and the split strategies as pure functions; the 80% note, mid-turn turns enforcement in the CLI, the cost counter, the UI step (T7) and the limit policy (T8) are not built |
| T6  | Division strategies: equal, weighted by `size:` or `weight:`, fair share of what is left, and a reserve; computed at the start and recomputed at each re-plan                                                                                                                        | T5                                                                                                                           | Each strategy gives the same budgets in a table-driven test; unused budget rolls forward under fair share; an item is capped at what the loop has left                                                                                                                                                      | Not started                                                                                                                                                                                                                                                |
| T7  | The budget step on the plan card when entering the loop: strategy menu, a number beside each to-do, a proposal from past runs in the usage ledger, set by the Plan edits level (person, planner, reviewer); skip leaves it at None                                                   | T1, T6                                                                                                                       | The plan card shows and edits per-item budgets; at Manual nothing applies without the person; with no history the proposal says so                                                                                                                                                                          | Not started                                                                                                                                                                                                                                                |
| T8  | At the limit, by policy: Suggest (inbox: extend, split, skip, block), Force, and Review (a reviewer or the `replan` model reads the work log and stuck signals; one extension at most, from the reserve, only for an item that is progressing); the re-plan sees the item's findings | T5, S3                                                                                                                       | Each autonomy level behaves as the table says on a scripted stuck item; an extension cannot exceed the reserve                                                                                                                                                                                              | Not started                                                                                                                                                                                                                                                |
| T9  | Per-item meters in the loop strip and the plan list, the same in the CLI strip and `/state`, `budget:` in the docs                                                                                                                                                                   | T5                                                                                                                           | The meter shows the closest limit of the running item; docs list the line and the strategies                                                                                                                                                                                                                | Partly built: once a budget is set each task shows its runs, tokens and time; the strip, the CLI and per-task cost are not                                                                                                                                 |

## Decisions for the owner

| #   | Decision                                 | Options and a recommendation                                                                                                                                                         |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Default for a new loop                   | Keep today's numbers (rounds 5, 10M tokens, 2 h) and add a cost budget only when the person sets one (recommended). A default dollar cap would surprise people on cheap local models |
| D2  | At the limit: stop or ask                | Ask when a person is watching, stop when not (recommended)                                                                                                                           |
| D3  | Does waiting on the person count as time | No (recommended): an unanswered question should not use up the time budget                                                                                                           |
| D4  | Default division strategy                | None until T6 is measured, then Fair share of what is left with a 20% reserve (recommended): it needs no sizes and wastes nothing                                                    |
| D5  | Who decides an extension at Auto         | A reviewer reading the work log and stuck signals (recommended), with the extension capped by the reserve and one per item. A rule alone cannot tell progress from churn             |
| D6  | Is `over_budget` a failure               | No. It keeps the work and the loop's strategy decides (a re-plan that splits it); a failed item counts toward the consecutive-failures stop, an over-budget one does not by itself   |
