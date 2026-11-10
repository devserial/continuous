import { RangeInFile } from "..";
import { NextEditProvider } from "./NextEditProvider";
import { NextEditOutcome } from "./types";

export interface ProcessedItem {
  location: RangeInFile;
  outcome: NextEditOutcome; // Result from the model
}

/**
 * Keeps a queue of the broken down diffs from a changed editable range, as determined in core/nextEdit/diff.ts
 */
/**
 * This is where the chain is stored. Think of it as a regular queue, but being a singleton because we need one source of truth for the chain.
 * I originally intended this to be a separate data structure to handle prefetching next edit outcomes from the model in the background.
 * Due to subpar results, lack of satisfactory next edit location suggestion algorithms and token cost/latency issues, I scratched the idea.
 */
export class PrefetchQueue {
  private static instance: PrefetchQueue | null = null;

  private unprocessedQueue: RangeInFile[] = [];
  private processedQueue: ProcessedItem[] = [];
  private prefetchLimit: number;
  private abortController: AbortController;
  /** Serializes process() so in-flight requests count toward the limit. */
  private tail: Promise<void> = Promise.resolve();

  private usingFullFileDiff: boolean = true;

  private constructor(prefetchLimit: number = 3) {
    this.prefetchLimit = prefetchLimit;
    this.abortController = new AbortController();
  }

  public static getInstance(prefetchLimit: number = 3): PrefetchQueue {
    if (!PrefetchQueue.instance) {
      PrefetchQueue.instance = new PrefetchQueue(prefetchLimit);
    }

    return PrefetchQueue.instance;
  }

  initialize(usingFullFileDiff: boolean) {
    this.usingFullFileDiff = usingFullFileDiff;
  }

  // Queue management methods
  enqueueUnprocessed(location: RangeInFile): void {
    this.unprocessedQueue.push(location);
  }

  private dequeueUnprocessed(): RangeInFile | undefined {
    return this.unprocessedQueue.shift();
  }

  enqueueProcessed(item: ProcessedItem): void {
    this.processedQueue.push(item);
  }

  dequeueProcessed(): ProcessedItem | undefined {
    return this.processedQueue.shift();
  }

  // Process items from unprocessed queue. One loop runs at a time; a call
  // made while another is in flight waits and then drains whatever is left.
  process(ctx: any): Promise<void> {
    const run = this.tail.then(() => this.drain(ctx));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async drain(ctx: any): Promise<void> {
    const controller = this.abortController;
    while (
      this.unprocessedQueue.length > 0 &&
      this.processedQueue.length < this.prefetchLimit &&
      !controller.signal.aborted
    ) {
      const location = this.dequeueUnprocessed();
      console.log("processing:");
      console.log(
        location?.range.start.line + " to " + location?.range.end.line,
      );

      if (!location) break;

      try {
        const outcome =
          await NextEditProvider.getInstance().provideInlineCompletionItemsWithChain(
            ctx,
            location,
            controller.signal,
            this.usingFullFileDiff,
          );

        // abort() swaps the controller and clears the queues. A result that
        // belongs to the previous run must not land in the new queue.
        if (controller.signal.aborted || controller !== this.abortController) {
          break;
        }

        if (!outcome) {
          console.log("outcome is undefined");
          continue;
        }

        if (this.processedQueue.length >= this.prefetchLimit) {
          break;
        }

        this.enqueueProcessed({
          location,
          outcome,
        });

        console.log(
          "the length of processed queue after processing is:",
          this.processedQueue.length,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          // Handle error
          console.error("Error processing item:", error);
        }
        // If aborted, we just stop processing
        break;
      }
    }
  }

  // Abort all operations
  abort(): void {
    this.abortController.abort();
    this.clear();

    // Create a new AbortController for future operations
    this.abortController = new AbortController();
  }

  // Clear all queues
  clear(): void {
    this.unprocessedQueue = [];
    this.processedQueue = [];
  }

  // Additional helper methods
  get unprocessedCount(): number {
    return this.unprocessedQueue.length;
  }

  get processedCount(): number {
    return this.processedQueue.length;
  }

  peekProcessed(): ProcessedItem | undefined {
    return this.processedQueue[0];
  }

  peekThreeProcessed(): void {
    const count = Math.min(3, this.processedQueue.length);
    const firstThree = this.processedQueue.slice(0, count);
    firstThree.forEach((item, index) => {
      console.debug(
        `Item ${index + 1}: ${item.location.range.start.line} to ${item.location.range.end.line}`,
      );
    });
  }

  setPreetchLimit(limit: number): void {
    this.prefetchLimit = limit;
  }
}
