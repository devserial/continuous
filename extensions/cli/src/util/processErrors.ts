import { markUnhandledError } from "./errorState.js";
import { gracefulExit } from "./exit.js";
import { logger } from "./logger.js";

let shuttingDown = false;

/**
 * Log a fatal error and leave with a non-zero status. Used for uncaught
 * exceptions and for a serve listener that cannot bind its port, so the
 * process does not sit idle after the failure.
 */
export function exitBecause(error: unknown, label: string): void {
  markUnhandledError();
  const asError = error instanceof Error ? error : new Error(String(error));
  logger.error(label, asError);
  if (shuttingDown) {
    process.exit(1);
    return;
  }
  shuttingDown = true;
  void gracefulExit(1).catch(() => {
    process.exit(1);
  });
}
