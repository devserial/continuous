/**
 * Captured when the CLI process starts, before any .env file is applied.
 * This module is imported first from init.ts and has no dependencies, so
 * nothing else has run yet.
 *
 * CONTINUOUS_IGNORE_CWD_ENV tells shared packages not to copy a
 * working-directory .env into this process. The variable is set here, before
 * those packages are imported.
 */
export const startupEnv: NodeJS.ProcessEnv = { ...process.env };

process.env.CONTINUOUS_IGNORE_CWD_ENV = "1";
