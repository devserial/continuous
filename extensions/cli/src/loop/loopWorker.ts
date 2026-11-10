import type { LoopReminder, LoopState, TaskPlan, Usage } from "core/index.js";
import type { ParallelRunResult } from "core/util/loopMode.js";

import { captureWorktreeDiff } from "../commands/review/worktree.js";
import {
  applyModelNamed,
  getService,
  initializeServices,
  SERVICE_NAMES,
  services,
} from "../services/index.js";
import type { ModelServiceState } from "../services/types.js";
import {
  clearSession,
  createSession,
  getSessionLoop,
  getSessionUsage,
  trackSessionUsage,
  updateSessionLoop,
  updateSessionTaskPlan,
} from "../session.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";

import { usageSince } from "./loopBudget.js";

/**
 * A worker of a parallel wave (L4): one item of the loop run in a forked
 * `cn` process whose working directory is the item's worktree, so every
 * tool, the git helpers and the checks work there. The parent
 * (loopWave.ts) forks `cn --internal-loop-worker`, sends the input over IPC
 * once the worker says it is ready, and gets the output back the same way.
 *
 * The worker's session starts with the parent's loop, its `current` naming
 * this item, and the parent's plan: FinishItem, HoldQuestion and RemindMe,
 * the plan block and the item-turn limit then work as they do inline, and
 * what the run held is read off the loop when the turn ends.
 */

export const LOOP_WORKER_FLAG = "--internal-loop-worker";

export interface LoopWorkerInput {
  /** The worktree the item runs in; the worker changes into it */
  worktree: string;
  /** The parent's config options, so the worker loads the same assistant */
  options: { config?: string; org?: string; rule?: string[] };
  /** The `name` of the chat model to run on (the item's own, or the loop's) */
  model?: string;
  /** The parent's loop, `current` naming this item (kind "item") */
  loop: LoopState;
  plan: TaskPlan;
  /** The item prompt (prepareItemRun); the plan block is added per request */
  prompt: string;
  /**
   * The parent's session usage when the worker started. The worker's own
   * session begins there, so the budget includes tokens already spent.
   */
  baselineUsage?: Usage;
}

export interface LoopWorkerOutput {
  /** What FinishItem reported, if it was called */
  report?: ParallelRunResult["report"];
  /** The questions the run held for this item */
  questions: NonNullable<ParallelRunResult["questions"]>;
  /** The reminders the run saved (RemindMe), with the worker's ids */
  reminders: LoopReminder[];
  /** The run's changes, as a unified diff from the worktree's baseline */
  patch: string;
  usage: Usage;
  /** Seconds the run took */
  duration: number;
  /** The run did not end on its own: what went wrong */
  error?: string;
}

/** Messages between the parent and the worker. */
export type LoopWorkerMessage =
  | { type: "ready" }
  | { type: "run-item"; input: LoopWorkerInput }
  /** Cumulative usage of this worker so far, so the parent can stop mid-item */
  | { type: "usage"; usage: Usage }
  | { type: "result"; result: LoopWorkerOutput };

const EMPTY_USAGE = { promptTokens: 0, completionTokens: 0 };

/**
 * Runs the item in this process, which is the worker: services start in
 * the worktree in auto mode (nobody can be asked), the model is switched to
 * the one the parent named, the session is seeded with the loop and the
 * plan, and the turn runs to its end. The session file the run saved is
 * removed afterwards: the worker's conversation is not one of the person's.
 */
export async function runLoopItemHere(
  input: LoopWorkerInput,
): Promise<LoopWorkerOutput> {
  const startTime = Date.now();
  const itemId = input.loop.current?.itemId;
  if (!itemId || input.loop.current?.kind !== "item") {
    throw new Error("The worker's loop does not name the item to run.");
  }
  process.chdir(input.worktree);
  await initializeServices({
    options: {
      config: input.options.config,
      org: input.options.org,
      rule: input.options.rule,
    },
    headless: true,
    toolPermissionOverrides: { mode: "auto" },
  });
  if (input.model) await applyModelNamed(input.model);
  const modelState = await getService<ModelServiceState>(SERVICE_NAMES.MODEL);
  if (!modelState.model || !modelState.llmApi) {
    throw new Error("The worker could not initialize its model.");
  }

  const session = createSession([]);
  await services.chatHistory.initialize(session, false);
  try {
    updateSessionTaskPlan(input.plan);
    // The run's request starts at its own prompt, as inline
    const historyIndex = services.chatHistory.getHistory().length;
    updateSessionLoop({
      ...input.loop,
      current: { ...input.loop.current, historyIndex },
    });
    services.chatHistory.addUserMessage(input.prompt);
    if (input.baselineUsage) {
      trackSessionUsage(0, input.baselineUsage);
    }
    const usageAtStart = getSessionUsage();
    const reportUsage = () => {
      if (typeof process.send !== "function") return;
      process.send({
        type: "usage",
        usage: usageSince(usageAtStart, getSessionUsage()),
      } satisfies LoopWorkerMessage);
    };

    await streamChatResponse(
      services.chatHistory.getHistory(),
      modelState.model,
      modelState.llmApi,
      new AbortController(),
      undefined,
      false,
      { persistSession: false, onRequest: reportUsage },
    );
    reportUsage();

    const after = getSessionLoop();
    const knownQuestions = new Set(input.loop.questions.map((q) => q.id));
    const knownReminders = new Set(
      (input.loop.reminders ?? []).map((r) => r.id),
    );
    const usage = getSessionUsage();
    return {
      report: after?.current?.report,
      questions: (after?.questions ?? [])
        .filter((q) => !knownQuestions.has(q.id) && q.itemId === itemId)
        .map((q) => ({
          question: q.question,
          kind: q.kind,
          assumption: q.assumption,
          type: q.type,
        })),
      reminders: (after?.reminders ?? []).filter(
        (r) => !knownReminders.has(r.id),
      ),
      patch: captureWorktreeDiff(input.worktree),
      usage: usageSince(usageAtStart, usage),
      duration: (Date.now() - startTime) / 1000,
    };
  } finally {
    try {
      clearSession();
    } catch {
      // best effort: the worker's session file is not the person's
    }
  }
}

/**
 * Entry point of the forked worker process: says it is ready, runs the one
 * item it is sent, answers with the result, and exits.
 */
export async function runLoopWorker(): Promise<void> {
  if (typeof process.send !== "function") {
    console.error(
      `Error: the loop worker must be run as a forked process (${LOOP_WORKER_FLAG}).`,
    );
    process.exit(1);
  }
  const send = (message: LoopWorkerMessage) => process.send!(message);

  process.on("message", async (msg: LoopWorkerMessage) => {
    if (msg.type !== "run-item") return;
    const startTime = Date.now();
    try {
      send({ type: "result", result: await runLoopItemHere(msg.input) });
    } catch (e: any) {
      send({
        type: "result",
        result: {
          questions: [],
          reminders: [],
          patch: "",
          usage: EMPTY_USAGE,
          duration: (Date.now() - startTime) / 1000,
          error: e?.message || String(e),
        },
      });
    }
  });

  send({ type: "ready" });
}
