import { Logger } from "../util/Logger.js";

/**
 * Close context providers that hold resources (database pools) before a
 * config reload drops them.
 */
export async function closeContextProviders(
  providers: readonly object[] | undefined,
): Promise<void> {
  for (const provider of providers ?? []) {
    const close = (provider as { close?: unknown }).close;
    if (typeof close !== "function") continue;
    try {
      await close.call(provider);
    } catch (err) {
      Logger.error(err, { context: "context_provider_close" });
    }
  }
}
