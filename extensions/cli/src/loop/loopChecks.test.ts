import { type ChildProcess } from "child_process";
import { EventEmitter } from "events";

import { getCommandExecutor } from "core/util/commandExecutor.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn };
});

import {
  killCheckProcess,
  LOOP_CHECK_TIMEOUT_MS,
  runCheckCommand,
} from "./loopChecks.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  (child.stdout as EventEmitter & { setEncoding: () => void }).setEncoding =
    () => {};
  (child.stderr as EventEmitter & { setEncoding: () => void }).setEncoding =
    () => {};
  child.kill = vi.fn();
  child.pid = 4242;
  return child;
}

describe("loop check commands use the approved shell", () => {
  afterEach(() => {
    spawn.mockReset();
    vi.useRealTimers();
  });

  it("spawns the command executor, not exec's sh or cmd", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const pending = runCheckCommand("echo hello", "/work");
    child.stdout.emit("data", "hello\n");
    child.emit("close", 0);
    await expect(pending).resolves.toEqual({ exitCode: 0, output: "hello" });

    const started = getCommandExecutor().invocation("echo hello");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      started.shell,
      started.args,
      expect.objectContaining({ cwd: "/work", windowsHide: true }),
    );
    // exec would have been `sh -c` / `cmd.exe /d /s /c`, which is a different
    // shell than the one the permission check classified.
    expect(started.args).not.toEqual(["-c", "echo hello"]);
    expect(String(spawn.mock.calls[0][0])).not.toMatch(/cmd(\.exe)?$/i);
  });

  it("keeps a non-zero exit and what the command printed", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const pending = runCheckCommand("npm test");
    child.stdout.emit("data", "1 failed");
    child.stderr.emit("data", "boom");
    child.emit("close", 3);
    await expect(pending).resolves.toEqual({
      exitCode: 3,
      output: "1 failed\nboom",
    });
  });

  it("a command that runs past the limit is stopped with its process group", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === -child.pid) child.emit("close", null);
      return true;
    });
    const pending = runCheckCommand("sleep 9999");
    await vi.advanceTimersByTimeAsync(LOOP_CHECK_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({
      exitCode: null,
      output: "(stopped after 10 minutes)",
    });
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: true }),
    );
    kill.mockRestore();
  });

  it("kills the process group, and on Windows the process tree", () => {
    const child = fakeChild();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    killCheckProcess(child as unknown as ChildProcess, "linux");
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");

    spawn.mockClear();
    killCheckProcess(child as unknown as ChildProcess, "win32");
    expect(spawn).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
    kill.mockRestore();
  });
});
