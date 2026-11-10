import { v4 as uuidv4 } from "uuid";

export class AutocompleteDebouncer {
  private debounceTimeout: NodeJS.Timeout | undefined = undefined;
  private currentRequestId: string | undefined = undefined;
  private pendingResolve: ((shouldDebounce: boolean) => void) | undefined =
    undefined;

  async delayAndShouldDebounce(debounceDelay: number): Promise<boolean> {
    // Generate a unique ID for this request
    const requestId = uuidv4();
    this.currentRequestId = requestId;

    // The previous request lost. Resolve it so its callers can run cleanup.
    this.settlePending(true);

    // Create a new promise that resolves after the debounce delay
    return new Promise<boolean>((resolve) => {
      this.pendingResolve = resolve;
      this.debounceTimeout = setTimeout(() => {
        // When the timeout completes, check if this is still the most recent request
        const shouldDebounce = this.currentRequestId !== requestId;

        // If this is the most recent request, it shouldn't be debounced
        if (!shouldDebounce) {
          this.currentRequestId = undefined;
        }

        this.settlePending(shouldDebounce);
      }, debounceDelay);
    });
  }

  private settlePending(shouldDebounce: boolean) {
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = undefined;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = undefined;
    resolve?.(shouldDebounce);
  }
}
