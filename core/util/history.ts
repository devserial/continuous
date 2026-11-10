import * as fs from "fs";
import * as path from "path";

import { BaseSessionMetadata, Session } from "../index.js";
import { ListHistoryOptions } from "../protocol/core.js";

import { NEW_SESSION_TITLE } from "./constants.js";
import {
  getSessionFilePath,
  getSessionsFolderPath,
  getSessionsListPath,
} from "./paths.js";
function safeParseArray<T>(
  value: string,
  errorMessage: string = "Error parsing array",
): T[] | undefined {
  try {
    return JSON.parse(value) as T[];
  } catch (e: any) {
    console.warn(`${errorMessage}: ${e}`);
    return undefined;
  }
}

/**
 * Replaces `file` by writing a temp file in the same directory and renaming
 * it over the destination. A crash mid-write leaves the temp file, and
 * readers keep seeing the previous complete file.
 */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // the temp file was already renamed, or never created
    }
    throw error;
  }
}

const SESSIONS_LOCK_WAIT_MS = 5_000;
const STALE_SESSIONS_LOCK_MS = 10_000;

function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/** One process at a time updates sessions.json. A lock older than 10s is stale. */
function withSessionsLock<T>(fn: () => T): T {
  const lockPath = `${getSessionsListPath()}.lock`;
  const deadline = Date.now() + SESSIONS_LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // a waiter may have cleared a stale lock already
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (
          Date.now() - fs.statSync(lockPath).mtimeMs >
          STALE_SESSIONS_LOCK_MS
        ) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // the holder released the lock between the stat and the unlink
      }
      if (Date.now() > deadline) {
        throw new Error(`Could not lock the session list at ${lockPath}`);
      }
      sleepSync(25);
    }
  }
}

function metadataFromSessionFile(
  file: string,
): BaseSessionMetadata | undefined {
  try {
    const session = JSON.parse(fs.readFileSync(file, "utf8")) as Session;
    if (!session || typeof session !== "object" || !session.sessionId) {
      return undefined;
    }
    const messageCount = Array.isArray(session.history)
      ? session.history.filter((item) => item?.message?.role === "assistant")
          .length
      : 0;
    return {
      sessionId: session.sessionId,
      title: session.title ?? "",
      dateCreated: String(fs.statSync(file).mtimeMs),
      workspaceDirectory: session.workspaceDirectory ?? "",
      messageCount,
    };
  } catch {
    return undefined;
  }
}

/** Rebuild the list from the session files when sessions.json cannot be read. */
function rebuildSessionsList(): BaseSessionMetadata[] {
  const folder = getSessionsFolderPath();
  return fs
    .readdirSync(folder)
    .filter(
      (name) =>
        name.endsWith(".json") &&
        name !== "sessions.json" &&
        !name.includes(".tmp"),
    )
    .flatMap((name) => {
      const meta = metadataFromSessionFile(path.join(folder, name));
      return meta ? [meta] : [];
    });
}

/**
 * The session list, or a list rebuilt from the session files when the file
 * is empty or not valid JSON. A bad file is renamed aside so the next save
 * can write a fresh one.
 */
function readSessionsList(file: string): BaseSessionMetadata[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new SyntaxError("sessions.json is not a list");
    }
    return parsed as BaseSessionMetadata[];
  } catch (error) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
    } catch {
      // still rebuild; the bad file may be replaced by the next write
    }
    console.warn(
      `sessions.json could not be read (${error instanceof Error ? error.message : String(error)}). It was backed up and the list was rebuilt from the session files.`,
    );
    return rebuildSessionsList();
  }
}

function updateSessionsList(
  update: (list: BaseSessionMetadata[]) => BaseSessionMetadata[],
): void {
  const file = getSessionsListPath();
  withSessionsLock(() => {
    const next = update(readSessionsList(file));
    writeAtomic(file, JSON.stringify(next, undefined, 2));
  });
}

export class HistoryManager {
  list(options: ListHistoryOptions): BaseSessionMetadata[] {
    const filepath = getSessionsListPath();
    if (!fs.existsSync(filepath)) {
      return [];
    }
    const content = fs.readFileSync(filepath, "utf8");

    let sessions = safeParseArray<BaseSessionMetadata>(content) ?? [];
    sessions = sessions
      .filter((session: any) => {
        // Filter out old format
        return typeof session.session_id !== "string";
        // Reverse to show newest first; sessions.json is chronological by creation
      })
      .reverse();

    // Filter by workspace directory if provided
    if (options.workspaceDirectory) {
      const target = options.workspaceDirectory.toLowerCase();
      sessions = sessions.filter(
        (session) =>
          typeof session.workspaceDirectory === "string" &&
          session.workspaceDirectory.toLowerCase() === target,
      );
    }

    // Apply limit and offset
    if (options.limit) {
      const offset = options.offset || 0;
      sessions = sessions.slice(offset, offset + options.limit);
    }

    return sessions;
  }

  delete(sessionId: string) {
    // Delete a session
    const sessionFile = getSessionFilePath(sessionId);
    if (!fs.existsSync(sessionFile)) {
      throw new Error(`Session file ${sessionFile} does not exist`);
    }
    fs.unlinkSync(sessionFile);

    updateSessionsList((sessionsList) =>
      sessionsList.filter((session) => session.sessionId !== sessionId),
    );
  }

  clearAll() {
    fs.rmSync(getSessionsFolderPath(), { recursive: true, force: true });
  }

  load(sessionId: string): Session {
    try {
      const sessionFile = getSessionFilePath(sessionId);
      if (!fs.existsSync(sessionFile)) {
        throw new Error(`Session file ${sessionFile} does not exist`);
      }
      const session: Session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      session.sessionId = sessionId;
      return session;
    } catch (e) {
      console.log(`Error loading session: ${e}`);
      return {
        history: [],
        title: NEW_SESSION_TITLE,
        workspaceDirectory: "",
        sessionId: sessionId,
      };
    }
  }

  save(session: Session) {
    // Save the main session json file
    // Explicitely rewriting here to influence the written key order in the file!
    // e.g. id at the top, history next, etc.
    const orderedSession: Session = {
      sessionId: session.sessionId,
      title: session.title,
      workspaceDirectory: session.workspaceDirectory,
      history: session.history,
    };
    if (session.mode) {
      orderedSession.mode = session.mode;
    }
    if (session.chatModelTitle !== undefined) {
      orderedSession.chatModelTitle = session.chatModelTitle;
    }
    if (session.usage !== undefined) {
      orderedSession.usage = session.usage;
    }
    if (session.promptCache !== undefined) {
      orderedSession.promptCache = session.promptCache;
    }
    if (session.checkpoints?.length) {
      orderedSession.checkpoints = session.checkpoints;
    }
    if (session.taskPlan?.items.length) {
      orderedSession.taskPlan = session.taskPlan;
    }
    if (session.planFile) {
      orderedSession.planFile = session.planFile;
    }
    if (session.queuedMessages?.length) {
      orderedSession.queuedMessages = session.queuedMessages;
    }
    if (session.loop) {
      orderedSession.loop = session.loop;
    }
    if (session.loopRequested) {
      orderedSession.loopRequested = true;
    }

    writeAtomic(
      getSessionFilePath(session.sessionId),
      JSON.stringify(orderedSession, undefined, 2),
    );

    const messageCount = session.history.filter(
      (item) => item.message.role === "assistant",
    ).length;
    updateSessionsList((sessionsList) => {
      let found = false;
      for (const sessionMetadata of sessionsList) {
        if (sessionMetadata.sessionId === session.sessionId) {
          sessionMetadata.title = session.title;
          sessionMetadata.workspaceDirectory = session.workspaceDirectory;
          sessionMetadata.messageCount = messageCount;
          found = true;
          break;
        }
      }
      if (!found) {
        sessionsList.push({
          sessionId: session.sessionId,
          title: session.title,
          dateCreated: String(Date.now()),
          workspaceDirectory: session.workspaceDirectory,
          messageCount,
        });
      }
      return sessionsList;
    });
  }
}

const historyManager = new HistoryManager();

export default historyManager;
