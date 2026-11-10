import * as fs from "fs";

import { v4 as uuidv4 } from "uuid";

import { Session } from "..";
import { NEW_SESSION_TITLE } from "./constants";
import historyManager from "./history";
import {
  getSessionFilePath,
  getSessionsFolderPath,
  getSessionsListPath,
} from "./paths";

const sessionId = uuidv4();
const testSession: Session = {
  history: [],
  title: `${sessionId} title`,
  workspaceDirectory: "workspaceDir",
  sessionId: sessionId,
};

describe("No sessions have been created", () => {
  const testSessionId = "invalid";
  const testSessionPath = getSessionFilePath(testSessionId);

  test("Listing all sessions returns empty list", () => {
    const sessions = historyManager.list({});
    expect(sessions).toEqual([]);
  });

  test("Deleting session throws error", () => {
    expect(() => {
      historyManager.delete(testSessionId);
    }).toThrow(`Session file ${testSessionPath} does not exist`);
  });

  test("Loading session returns default session", () => {
    const session = historyManager.load(testSessionId);
    expect(session).toEqual({
      history: [],
      title: NEW_SESSION_TITLE,
      workspaceDirectory: "",
      sessionId: testSessionId,
    });
  });
});

describe("Full session lifecycle", () => {
  test("Creating and listing a session", () => {
    // save and list
    historyManager.save(testSession);
    const sessions = historyManager.list({});
    const sessionExists = sessions.some(
      (session) => session?.sessionId === testSession.sessionId,
    );
    expect(sessionExists).toBe(true);
  });

  test("Loading session by ID returns correct object", () => {
    const retrievedSession = historyManager.load(testSession.sessionId);
    expect(retrievedSession).toEqual(testSession);
  });

  test("Saving session with new title updates session", () => {
    const modifiedSession = { ...testSession };
    modifiedSession.title = `Edited: ${testSession.title}`;
    historyManager.save(modifiedSession);
    const session = historyManager.load(testSession.sessionId);

    expect(session.title).toBe(modifiedSession.title);
  });

  test("The prompt cache record is saved and loaded with the session", () => {
    const promptCache = {
      lastRequestAt: 1_700_000_000_000,
      lastInputTokens: 366_000,
      lastTtl: "5m" as const,
    };
    historyManager.save({ ...testSession, promptCache });
    expect(historyManager.load(testSession.sessionId).promptCache).toEqual(
      promptCache,
    );
  });

  test("A session saved without a prompt cache record loads without one", () => {
    historyManager.save(testSession);
    expect(
      historyManager.load(testSession.sessionId).promptCache,
    ).toBeUndefined();
  });

  test("The task list is saved and loaded with the session", () => {
    const taskPlan = {
      items: [
        { id: "1", text: "Write the migration", status: "completed" as const },
        {
          id: "2",
          text: "Run it",
          status: "in_progress" as const,
          activeForm: "Running it",
        },
        {
          id: "3",
          text: "Deploy",
          status: "blocked" as const,
          note: "waiting for keys",
        },
      ],
      updatedAt: "2026-11-06T12:00:00.000Z",
      updatedBy: "user" as const,
    };
    historyManager.save({ ...testSession, taskPlan });
    expect(historyManager.load(testSession.sessionId).taskPlan).toEqual(
      taskPlan,
    );
  });

  test("The plan file is saved and loaded with the session", () => {
    const planFile = "file:///work/repo/.continuous/plans/add-retry.md";
    historyManager.save({ ...testSession, planFile });
    expect(historyManager.load(testSession.sessionId).planFile).toBe(planFile);
  });

  test("An empty task list is not written", () => {
    historyManager.save({
      ...testSession,
      taskPlan: { items: [], updatedAt: "2026-11-06T12:00:00.000Z" },
    });
    expect(historyManager.load(testSession.sessionId).taskPlan).toBeUndefined();
  });

  test("Queued messages are saved and loaded with the session, and cleared when empty", () => {
    const queuedMessages = [
      {
        id: "q1",
        editorState: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "next" }] },
          ],
        },
        modifiers: { useCodebase: false, noContext: false },
      },
    ];
    historyManager.save({ ...testSession, queuedMessages });
    expect(historyManager.load(testSession.sessionId).queuedMessages).toEqual(
      queuedMessages,
    );

    historyManager.save({ ...testSession, queuedMessages: [] });
    expect(
      historyManager.load(testSession.sessionId).queuedMessages,
    ).toBeUndefined();
  });

  test("Deleting session", () => {
    historyManager.delete(testSession.sessionId);
    const sessions = historyManager.list({});
    const sessionWasDeleted = sessions.every(
      (session) => session?.sessionId !== testSession.sessionId,
    );
    expect(sessionWasDeleted).toEqual(true);
  });
});

describe("Workspace directory filtering", () => {
  beforeAll(() => {
    historyManager.clearAll();
    historyManager.save({
      history: [],
      title: "Project A session 1",
      workspaceDirectory: "/home/user/project-a",
      sessionId: "ws-a-1",
    });
    historyManager.save({
      history: [],
      title: "Project B session 1",
      workspaceDirectory: "/home/user/project-b",
      sessionId: "ws-b-1",
    });
    historyManager.save({
      history: [],
      title: "Project A session 2",
      workspaceDirectory: "/home/user/project-a",
      sessionId: "ws-a-2",
    });
    historyManager.save({
      history: [],
      title: "No workspace",
      workspaceDirectory: "",
      sessionId: "ws-none",
    });
  });

  afterAll(() => {
    historyManager.clearAll();
  });

  test("Filter sessions by workspace directory", () => {
    const sessions = historyManager.list({
      workspaceDirectory: "/home/user/project-a",
    });
    expect(sessions.length).toBe(2);
    expect(
      sessions.every((s) => s.workspaceDirectory === "/home/user/project-a"),
    ).toBe(true);
  });

  test("Omitting workspace returns all sessions", () => {
    const sessions = historyManager.list({});
    expect(sessions.length).toBe(4);
  });

  test("Workspace filter is case-insensitive", () => {
    const sessions = historyManager.list({
      workspaceDirectory: "/HOME/USER/PROJECT-A",
    });
    expect(sessions.length).toBe(2);
  });

  test("Non-matching workspace returns empty list", () => {
    const sessions = historyManager.list({
      workspaceDirectory: "/home/user/nonexistent",
    });
    expect(sessions.length).toBe(0);
  });

  test("Workspace filter works with limit", () => {
    const sessions = historyManager.list({
      workspaceDirectory: "/home/user/project-a",
      limit: 1,
    });
    expect(sessions.length).toBe(1);
  });

  test("Workspace filter works with limit and offset", () => {
    const sessions = historyManager.list({
      workspaceDirectory: "/home/user/project-a",
      limit: 1,
      offset: 1,
    });
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("ws-a-1");
  });
});

describe("Many sessions created", () => {
  test("Create 100 sessions and list all", () => {
    for (let i = 0; i < 100; i++) {
      historyManager.save({
        history: [],
        title: `${i}`,
        workspaceDirectory: "workspaceDir",
        sessionId: `${i}`,
      });
    }
    const sessions = historyManager.list({});
    expect(sessions.length).toBe(100);
  });

  test("List 10 sessions, offest by 10", () => {
    const limit = 10;
    const offset = 10;

    const sessions = historyManager.list({ offset: offset, limit: limit });
    // Sessions are now reversed, so newest (99) comes first
    const sessionIds = Array.from({ length: limit }, (_, i) =>
      (99 - offset - i).toString(),
    );
    const isSessionIdInList = (sessionId: string) =>
      sessions.some((session) => session.sessionId === sessionId);
    expect(sessionIds.every(isSessionIdInList)).toBe(true);
  });

  test("List 25 sessions, with no offset", () => {
    const limit = 25;

    const sessions = historyManager.list({ limit: limit });
    // Sessions are now reversed, so newest (99) comes first
    const sessionIds = Array.from({ length: limit }, (_, i) =>
      (99 - i).toString(),
    );

    const isSessionIdInList = (sessionId: string) =>
      sessions.some((session) => session.sessionId === sessionId);
    expect(sessionIds.every(isSessionIdInList)).toBe(true);
  });

  test("List sessions offset by 75", () => {
    const offset = 75;

    const sessions = historyManager.list({ offset: offset });
    const sessionIds = Array.from(
      { length: sessions.length - offset },
      (_, i) => (i + offset).toString(),
    );

    const isSessionIdInList = (sessionId: string) =>
      sessions.some((session) => session.sessionId === sessionId);
    expect(sessionIds.every(isSessionIdInList)).toBe(true);
  });

  test("Delete all sessions", () => {
    let sessions = historyManager.list({});

    for (let session of sessions) {
      historyManager.delete(session.sessionId);
    }
    sessions = historyManager.list({});
    expect(sessions.length).toBe(0);
  });
});

describe("Session saves are atomic", () => {
  const session: Session = {
    history: [],
    title: "Atomic",
    workspaceDirectory: "workspaceDir",
    sessionId: "atomic-save",
  };

  test("the session file and the list are replaced, not written in place", () => {
    historyManager.save(session);
    const sessionFile = getSessionFilePath(session.sessionId);
    const listFile = getSessionsListPath();
    const sessionInode = fs.statSync(sessionFile).ino;
    const listInode = fs.statSync(listFile).ino;

    historyManager.save({ ...session, title: "Atomic 2" });

    // rename onto the destination gives it a new inode; writeFileSync in
    // place keeps the old one
    expect(fs.statSync(sessionFile).ino).not.toBe(sessionInode);
    expect(fs.statSync(listFile).ino).not.toBe(listInode);
    expect(
      fs
        .readdirSync(getSessionsFolderPath())
        .filter((name) => name.includes(".tmp")),
    ).toEqual([]);
    expect(JSON.parse(fs.readFileSync(sessionFile, "utf8")).title).toBe(
      "Atomic 2",
    );
  });

  test("a corrupt sessions.json is backed up and the list is rebuilt", () => {
    const listFile = getSessionsListPath();
    fs.writeFileSync(listFile, "{not json");
    expect(() =>
      historyManager.save({
        ...session,
        sessionId: "after-corrupt",
        title: "After",
      }),
    ).not.toThrow();

    const sessions = historyManager.list({});
    expect(sessions.some((s) => s.sessionId === "atomic-save")).toBe(true);
    expect(sessions.some((s) => s.sessionId === "after-corrupt")).toBe(true);
    expect(
      fs
        .readdirSync(getSessionsFolderPath())
        .some((name) => name.startsWith("sessions.json.corrupt-")),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(listFile, "utf8"))).toEqual(
      expect.any(Array),
    );
  });

  test("a stale lock does not block the next save", () => {
    const lock = `${getSessionsListPath()}.lock`;
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(() =>
      historyManager.save({
        ...session,
        sessionId: "after-lock",
        title: "Unlocked",
      }),
    ).not.toThrow();
    expect(fs.existsSync(lock)).toBe(false);
    expect(
      historyManager.list({}).some((s) => s.sessionId === "after-lock"),
    ).toBe(true);
  });
});
