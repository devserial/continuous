import { describe, expect, it } from "vitest";
import {
  classifyReadOnly,
  MAX_READ_ONLY_COMMAND_LENGTH,
  type ReadOnlyOptions,
} from "./readOnlyCommand";

const CLEAN: ReadOnlyOptions = {
  shell: "bash",
  cwd: "/repo",
  home: "/home/u",
  readGitConfig: () => "[core]\n\tbare = false\n",
  // /repo is a repository
  probe: (file) => (posix(file) === "/repo/.git" ? "dir" : undefined),
};

const posix = (file: string) => file.split(String.fromCharCode(92)).join("/");
const RUNS_A_PROGRAM = ["[core]", "	fsmonitor = /tmp/x", ""].join(
  String.fromCharCode(10),
);

const vouched = (command: string, opts: ReadOnlyOptions = CLEAN) =>
  classifyReadOnly(command, opts).vouched;
const why = (command: string, opts: ReadOnlyOptions = CLEAN) => {
  const r = classifyReadOnly(command, opts);
  return r.vouched ? "" : r.why;
};

describe("commands that only read", () => {
  it.each([
    "ls",
    "ls -la src",
    "cat README.md",
    "head -n 20 file.txt",
    "grep -rn TODO src",
    "rg --files -g '*.ts'",
    "find . -name '*.ts' -type f",
    "sed -n '10,20p' file.ts",
    "sort file.txt | uniq",
    "cat a.txt | wc -l",
    "ls && pwd",
    "ls 2>/dev/null",
    "ls > /dev/null 2>&1",
    "cd src; ls",
    "diff a.txt b.txt",
    "jq .name package.json",
    "git status",
    "git log --oneline -n 20",
    "git diff HEAD~1 -- src",
    "git show HEAD:README.md",
    "git branch --list",
    "git --no-pager log",
    "git stash list",
    "git stash show",
    "git grep -n TODO src",
    "sort -u file.txt",
    "uniq file.txt",
    "uniq -c file.txt",
  ])("vouches %s", (command) => {
    expect(vouched(command)).toBe(true);
  });

  it("the claim says who judged and what it found", () => {
    expect(classifyReadOnly("git log | head", CLEAN)).toEqual({
      vouched: true,
      judge: "parser",
      claim: "only reads: git log, head",
    });
  });
});

describe("what is not understood is not vouched", () => {
  it.each([
    ["echo $(whoami)", "$"],
    ["echo `whoami`", "`"],
    ["echo ${HOME}", "$"],
    ["ls > out.txt", "redirect"],
    ["ls >> out.txt", "redirect"],
    ["cat < in.txt", "redirect"],
    ["ls &", "background"],
    ["ls\nrm -rf x", "newline"],
    ["(ls)", "("],
    ["FOO=bar ls", "environment prefix"],
    ['echo "$HOME"', "double quotes"],
    ["ls '", "unterminated"],
    ["ls | ", "ends on an operator"],
    ["cat \\\\server\\share\\file", "network path"],
  ])("%s", (command, reason) => {
    expect(vouched(command)).toBe(false);
    expect(why(command)).toContain(reason);
  });

  it("a command over 10,000 characters is not vouched", () => {
    expect(vouched("echo " + "a".repeat(MAX_READ_ONLY_COMMAND_LENGTH))).toBe(
      false,
    );
  });

  it("every part of a pipeline must read, so one write spoils it", () => {
    expect(vouched("cat a | tee b")).toBe(false);
    expect(why("ls && rm file")).toContain("rm is not on the read-only list");
  });
});

describe("commands that are never read-only", () => {
  it.each([
    "awk '{print}' f",
    "python -c 1",
    "node x.js",
    "xargs ls",
    "eval ls",
    "source x",
    "curl https://example.com",
    "wget https://example.com",
    "gh pr view 1",
    "git fetch",
    "git push",
    "git checkout main",
    "git commit -m x",
    "git reset --hard",
    "npm test",
    "rm -rf x",
    "mv a b",
    "touch a",
    "env ls",
  ])("%s", (command) => {
    expect(vouched(command)).toBe(false);
  });
});

describe("arguments that make a read-only command write or run", () => {
  it.each([
    ["find . -delete", "-delete"],
    ["find . -exec ls x +", "-exec"],
    ["find . -fprint out.txt", "-fprint"],
    ["sort -o out.txt in.txt", "-o"],
    ["sort -o/tmp/x f", "-o"],
    ["sort -uo out.txt", "-o"],
    ["sort --output=out.txt in.txt", "--output"],
    ["sort --outp=src/index.js f", "--outp"],
    ["sort --compress-prog=sh f", "--compress-prog"],
    ["tree -o/tmp/x", "-o"],
    ["tail --fol x", "--fol"],
    ["date --se=now", "--se"],
    ["rg --pre ./x pattern", "--pre"],
    ["sed -i s/a/b/ f", "sed"],
    ["sed -n 'w out.txt' f", "print range"],
    ["sed 's/a/b/' f", "sed"],
    ["file -m magic f", "-m"],
    ["tail -f log.txt", "-f"],
    ["date -s 12:00", "-s"],
    ["uniq in.txt out.txt", "written"],
    ["uniq - package.json", "written"],
    ["uniq -- in.txt out.txt", "written"],
    ["jq -f prog.jq data.json", "-f"],
    ["hostname newname", "hostname"],
  ])("%s", (command, reason) => {
    expect(vouched(command)).toBe(false);
    expect(why(command)).toContain(reason);
  });
});

describe("globs the shell expands", () => {
  it.each([
    "rg TODO *",
    "rg pattern *.txt",
    "sort *.txt",
    "git grep TODO *",
    "find . -name *.ts",
    "ls *.ts | rg TODO *",
  ])("does not vouch %s", (command) => {
    expect(vouched(command)).toBe(false);
    expect(why(command)).toContain("glob");
  });

  it.each([
    "ls *",
    "ls *.ts",
    "cat *.md",
    "head *.txt",
    "wc *",
    "rg --files -g '*.ts'",
    "find . -name '*.ts' -type f",
    "rg TODO -- *",
    "ls *.ts | head",
  ])("still vouches %s", (command) => {
    expect(vouched(command)).toBe(true);
  });
});

describe("git", () => {
  it("is not vouched after a cd: the folder it runs in was not checked", () => {
    expect(why("cd other && git log")).toContain("after cd");
    expect(why("cd /elsewhere; git status")).toContain("after cd");
    // a cd that follows git, or no git at all, changes nothing
    expect(vouched("git log && cd src")).toBe(true);
    expect(vouched("cd src && ls")).toBe(true);
  });

  it("looks up the tree for the repository, so a subfolder is checked too", () => {
    const scanned: string[] = [];
    const opts: ReadOnlyOptions = {
      ...CLEAN,
      cwd: "/repo/packages/app",
      readGitConfig: (file) => {
        scanned.push(posix(file));
        return posix(file) === "/repo/.git/config" ? RUNS_A_PROGRAM : "";
      },
    };
    expect(vouched("git status", opts)).toBe(false);
    expect(scanned).toContain("/repo/.git/config");
  });

  it("is not vouched in a worktree or submodule, where .git is a file", () => {
    const opts: ReadOnlyOptions = {
      ...CLEAN,
      probe: (file) => (posix(file) === "/repo/.git" ? "file" : undefined),
    };
    expect(why("git status", opts)).toContain("worktree or submodule");
    // reading files needs no git at all
    expect(vouched("ls", opts)).toBe(true);
  });

  it("outside any repository only the user's config can matter", () => {
    const opts: ReadOnlyOptions = { ...CLEAN, probe: () => undefined };
    expect(vouched("git status", opts)).toBe(true);
    expect(
      vouched("git status", { ...opts, readGitConfig: () => RUNS_A_PROGRAM }),
    ).toBe(false);
  });

  it("is not vouched without a folder to check", () => {
    expect(why("git status", { ...CLEAN, cwd: undefined })).toContain(
      "without a folder",
    );
  });

  it.each([
    "[core]\n\tfsmonitor = /tmp/x\n",
    "[core]\n\thooksPath = /tmp/hooks\n",
    "[core]\n\tsshCommand = ssh -i key\n",
    '[diff "x"]\n\ttextconv = cat\n',
    '[filter "lfs"]\n\tclean = git-lfs clean\n',
    "[include]\n\tpath = /tmp/more\n",
    '[includeIf "gitdir:~/"]\n\tpath = x\n',
    "[core]fsmonitor=touch /tmp/x",
    "[core] fsmonitor = touch /tmp/x",
    "[core]\n\tpager = less\n",
    "[pager]\n\tstatus = less\n",
    '[diff "x"]\n\tcommand = cat\n',
    '[diff "x"] command = cat\n',
    "[core]\n\talternateRefsCommand = cat\n",
    "# fsmonitor is only a comment\n[core]fsmonitor=x\n",
  ])("is not vouched when a config can run programs: %s", (config) => {
    const opts = { ...CLEAN, readGitConfig: () => config };
    expect(vouched("git status", opts)).toBe(false);
    expect(why("git log", opts)).toContain("can run programs");
  });

  it("a comment that only mentions a dangerous key does not count", () => {
    expect(
      vouched("git status", {
        ...CLEAN,
        readGitConfig: () =>
          "# fsmonitor = x\n; pager = less\n[core]\n\tbare = false\n",
      }),
    ).toBe(true);
  });

  it("reads the worktree config, the system file, and the XDG file", () => {
    const seen: string[] = [];
    const opts: ReadOnlyOptions = {
      ...CLEAN,
      env: { XDG_CONFIG_HOME: "/xdg", GIT_CONFIG_SYSTEM: "/etc/gitconfig" },
      readGitConfig: (file) => {
        seen.push(posix(file));
        return posix(file).endsWith("/.git/config.worktree")
          ? "[core]fsmonitor=x\n"
          : "[core]\n\tbare = false\n";
      },
    };
    expect(vouched("git status", opts)).toBe(false);
    expect(seen.some((f) => f.endsWith("/.git/config.worktree"))).toBe(true);
    expect(seen).toContain("/etc/gitconfig");
    expect(seen).toContain("/xdg/git/config");
  });

  it("reads an include target, including one named by includeIf", () => {
    const included = (file: string, marker: string) => {
      const seen: string[] = [];
      const opts: ReadOnlyOptions = {
        ...CLEAN,
        env: {},
        readGitConfig: (f) => {
          const p = posix(f);
          seen.push(p);
          if (p.endsWith(file)) return marker;
          if (p.endsWith("/included.conf") || p.endsWith("/extra.conf")) {
            return "[core]\n\tfsmonitor = x\n";
          }
          return "";
        },
      };
      expect(vouched("git status", opts)).toBe(false);
      return seen;
    };
    expect(
      included("/.git/config", "[include]\n\tpath = ../included.conf\n").some(
        (f) => f.endsWith("/included.conf"),
      ),
    ).toBe(true);
    expect(
      included(
        "/.gitconfig",
        '[includeIf "gitdir:~/"]\n\tpath = ~/extra.conf\n',
      ).some((f) => f.endsWith("/extra.conf")),
    ).toBe(true);
  });

  it("a clean include target still allows a vouched git command", () => {
    const opts: ReadOnlyOptions = {
      ...CLEAN,
      env: {},
      readGitConfig: (file) =>
        posix(file).endsWith("/.git/config")
          ? "[include]\n\tpath = ../clean.conf\n"
          : "[core]\n\tbare = false\n",
    };
    expect(vouched("git status", opts)).toBe(true);
  });

  it("GIT_CONFIG_GLOBAL replaces the home gitconfig", () => {
    const seen: string[] = [];
    const opts: ReadOnlyOptions = {
      ...CLEAN,
      env: { GIT_CONFIG_GLOBAL: "/custom/gitconfig" },
      readGitConfig: (file) => {
        seen.push(posix(file));
        return posix(file) === "/custom/gitconfig"
          ? "[core]\n\tpager = less\n"
          : "";
      },
    };
    expect(vouched("git status", opts)).toBe(false);
    expect(seen).toContain("/custom/gitconfig");
    expect(seen.some((f) => f.endsWith("/.gitconfig"))).toBe(false);
  });

  it("a config key supplied by the environment is checked too", () => {
    const opts: ReadOnlyOptions = {
      ...CLEAN,
      env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor" },
      readGitConfig: () => "[core]\n\tbare = false\n",
    };
    expect(why("git status", opts)).toContain("can run programs");
  });

  it("checks the user's config as well as the repository's", () => {
    const opts: ReadOnlyOptions = {
      ...CLEAN,
      readGitConfig: (file) =>
        file.endsWith(".gitconfig") ? "[core]\n\tfsmonitor = x\n" : "",
    };
    expect(vouched("git status", opts)).toBe(false);
  });

  it.each([
    "git -c core.fsmonitor=x status",
    "git -C /other status",
    "git --git-dir=/x status",
    "git --exec-path=/x status",
    "git -p log",
    "git log --output=out.txt",
    "git log -Oout",
    "git diff --output out.txt",
    "git diff --outp=x",
    "git diff --ext-diff",
    "git grep --open-files-in-pager=less x",
    'git grep -O"touch /tmp/x" hello',
    "git grep --open-files-in=less hello",
    "git grep --open-f=less hello",
    "git grep -nOtouch hello",
    "git stash show --output=out.txt",
    "git stash show --outp=out.txt",
    "git shortlog --output=out.txt HEAD",
    "git rev-list --output=out.txt HEAD",
    "git branch -D old",
    "git branch new-branch",
    "git tag v1",
    "git remote add x y",
    "git remote update",
    "git stash drop",
    "git cat-file --batch",
    "git config user.name x",
  ])("refuses what changes what runs: %s", (command) => {
    expect(vouched(command)).toBe(false);
  });
});

const PS: ReadOnlyOptions = { ...CLEAN, shell: "powershell" };
const ZSH: ReadOnlyOptions = { ...CLEAN, shell: "zsh" };

describe("the shell decides what a command is", () => {
  it("without a shell nothing is vouched, and cmd and unknown shells are not parsed", () => {
    expect(why("ls", { ...CLEAN, shell: undefined })).toContain("not known");
    expect(vouched("dir", { ...CLEAN, shell: "cmd" })).toBe(true);
    expect(why("ls", { ...CLEAN, shell: "unknown" })).toContain("not parsed");
  });

  it("sh and zsh read what bash reads", () => {
    for (const shell of ["sh", "zsh", "bash"] as const) {
      expect(vouched("ls -la | head", { ...CLEAN, shell })).toBe(true);
      expect(vouched("echo $(whoami)", { ...CLEAN, shell })).toBe(false);
    }
  });

  it("a backslash in a POSIX shell is an escape, so it is not understood", () => {
    // bash runs the rm: the \' is a quote that does not open one. A scanner
    // that read the backslash as a letter would see one harmless echo.
    const attack = String.raw`echo \'; rm -rf x; echo \'`;
    for (const shell of ["bash", "zsh", "sh"] as const) {
      expect(why(attack, { ...CLEAN, shell })).toContain("backslash");
      expect(why(String.raw`ls a\ b`, { ...CLEAN, shell })).toContain(
        "backslash",
      );
    }
  });

  it("zsh expands =cmd, so it is not understood there", () => {
    expect(why("=ls", ZSH)).toContain("zsh");
    // zsh expands it in an argument as well
    expect(why("echo =ls", ZSH)).toContain("zsh");
    expect(vouched("echo a=b", ZSH)).toBe(true);
  });

  it("date, find and the rest are checked against the shell's own list", () => {
    expect(vouched("date")).toBe(true);
    expect(vouched("date", PS)).toBe(false);
    expect(vouched("find . -name x", PS)).toBe(false);
    expect(why("find . -name x", PS)).toContain("PowerShell read-only list");
  });
});

describe("PowerShell", () => {
  it.each([
    "Get-ChildItem -Recurse src",
    "gci src",
    "ls src",
    "Get-Content README.md | Select-Object -First 10",
    "cat README.md | Select-String TODO",
    "dir | Sort-Object Length",
    "Get-Item C:\\src\\a.ts",
    "ls C:\\Users\\me\\src",
    "Test-Path .git",
    "rg --files -g '*.ts'",
    "git status",
    "git log --oneline",
    "Set-Location src; ls",
  ])("vouches %s", (command) => {
    expect(vouched(command, PS)).toBe(true);
  });

  it("a backslash is a path separator there, not an escape", () => {
    expect(vouched("Get-Content src\\a.ts", PS)).toBe(true);
  });

  it.each([
    ["Get-ChildItem @args", "@"],
    ["ls $env:USERPROFILE", "$"],
    ["Get-Content `x", "`"],
    ["Get-Content a.txt > out.txt", "redirect"],
    ["Get-Content (Get-Item x)", "("],
    ["& ls", "call operator"],
    ["Remove-Item x", "not a known read cmdlet"],
    ["Set-Content a.txt hi", "not a known read cmdlet"],
    ["Tee-Object -FilePath x", "not a known read cmdlet"],
    ["Invoke-Expression 'ls'", "not a known read cmdlet"],
    ["iex ls", "not a known read cmdlet"],
    ["curl https://example.com", "not a known read cmdlet"],
    ["Start-Process notepad", "not a known read cmdlet"],
    ["powershell -EncodedCommand AAAA", "not on the PowerShell read-only list"],
    ["\\\\server\\share\\f", "network path"],
  ])("%s", (command, reason) => {
    expect(vouched(command, PS)).toBe(false);
    expect(why(command, PS)).toContain(reason);
  });

  it("git after Set-Location is not vouched either", () => {
    expect(why("Set-Location other; git log", PS)).toContain("after cd");
    expect(why("sl other; git log", PS)).toContain("after cd");
  });

  it("the claim names what it found", () => {
    expect(
      classifyReadOnly("Get-Content a | Select-Object -First 2", PS),
    ).toEqual({
      vouched: true,
      judge: "parser",
      claim: "only reads: get-content, select-object",
    });
  });
});

describe("PowerShell parameters", () => {
  it.each([
    "Get-ChildItem -Recurse src",
    "Get-ChildItem -Rec src",
    "Get-ChildItem -recurse -Force",
    "ls -Name",
    "gci -File",
    "Get-Content a.txt -Tail 5",
    "Get-Content -Path:a.txt",
    "Get-Content a.txt -Wait",
    "gc -TotalCount 3 a.txt",
    "Select-String -Pattern x -Path a.txt",
    "Select-String x a.txt -Quiet",
    "Get-Process",
    "Get-Process -Name node",
    "Get-Service -Name x",
    "Sort-Object -Descending",
    "ls | Sort-Object -Property Length -Descending | Select-Object -First 3",
    "Get-Content a.txt -ErrorAction SilentlyContinue",
    "Get-ChildItem -ea 0",
  ])("vouches %s", (command) => {
    expect(vouched(command, PS)).toBe(true);
  });

  it.each([
    ["Get-ChildItem -Foo", "not recognised"],
    ["Get-ChildItem -r", "ambiguous"],
    ["Get-Content -Wait:$true", "$"],
    ["Select-String --% x", "stop-parsing"],
    ["Get-Content a.txt -Credential x", "not recognised for"],
    ["Get-Date -Set", "not recognised"],
  ])("%s", (command, reason) => {
    expect(vouched(command, PS)).toBe(false);
    expect(why(command, PS)).toContain(reason);
  });

  it("an alias is checked as the cmdlet it stands for", () => {
    // -Recurse is a Get-ChildItem parameter, so `ls -Recurse` is read
    expect(vouched("ls -Recurse", PS)).toBe(true);
    // but sort is Sort-Object, which has no -Path
    expect(why("sort -Path x", PS)).toContain("not recognised for sort-object");
    // and rm is Remove-Item, a cmdlet that is not read-only whatever its parameters
    expect(why("rm -Rec x", PS)).toContain("remove-item");
  });

  it("the claim names the cmdlet, not the alias", () => {
    expect(classifyReadOnly("ls -Rec | sort", PS)).toEqual({
      vouched: true,
      judge: "parser",
      claim: "only reads: get-childitem, sort-object",
    });
  });
});

const CMD: ReadOnlyOptions = { ...CLEAN, shell: "cmd" };

describe("cmd", () => {
  it.each([
    "dir",
    "dir /s",
    "dir /a:h /b",
    "dir src",
    "dir C:\\src\\a",
    "type a.txt",
    "type a.txt & dir",
    "cd",
    "cd src",
    "cd /d C:\\src",
    "echo hi",
    "ver",
    "set",
    "set PATH",
    "dir & type a.txt",
    "dir && cd src",
    "dir 2>nul",
    "dir > nul 2>&1",
    'type "a b.txt"',
  ])("vouches %s: cmd runs its own commands itself", (command) => {
    expect(vouched(command, CMD)).toBe(true);
  });

  it.each([
    ["findstr x f.txt", "may be a file"],
    ["where git", "may be a file"],
    ["git status", "may be a file"],
    ["tree", "may be a file"],
    ["del a.txt", "may be a file"],
    ["dir %USERPROFILE%", "expansion"],
    ["echo %PATH%", "expansion"],
    ["echo !x!", "expansion"],
    ['echo "%x%"', "expansion inside quotes"],
    ["echo a ^& b", "^"],
    ["dir > out.txt", "not understood"],
    ["type a.txt > b.txt", "not understood"],
    ["if exist a (dir)", "("],
    ["dir /x:y", "switch"],
    ["type /b a.txt", "no switches"],
    ["cd a b c", "several arguments"],
    ["set X=1", "not understood"],
    ["set /p x=", "not understood"],
    ["path C:\\x", "sets it"],
    ["ver /?", "no arguments"],
    ["call build.bat", "may be a file"],
    ["dir ;", "not understood"],
  ])("%s", (command, reason) => {
    expect(vouched(command, CMD)).toBe(false);
    expect(why(command, CMD)).toContain(reason);
  });

  it("a name with a dot is a file, never one of cmd's own commands", () => {
    expect(vouched("dir.bat", CMD)).toBe(false);
    expect(vouched("type.exe a", CMD)).toBe(false);
  });
});
