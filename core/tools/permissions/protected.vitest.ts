import { describe, expect, it } from "vitest";
import {
  normalizeProtectedPath,
  protectedPathHit,
  protectedReason,
} from "./protected";

const HOME = "C:\\Users\\me";
const hit = (
  p: string,
  kinds: ("secret" | "config")[] = ["secret", "config"],
) => protectedPathHit(p, kinds, HOME)?.kind;

describe("normalizeProtectedPath", () => {
  it("uses ~ for the home directory in every spelling", () => {
    expect(
      normalizeProtectedPath("C:\\Users\\me\\.aws\\credentials", HOME),
    ).toBe("~/.aws/credentials");
    expect(normalizeProtectedPath("c:/users/ME/.ssh/id_rsa", HOME)).toBe(
      "~/.ssh/id_rsa",
    );
    expect(normalizeProtectedPath("$HOME/.ssh", HOME)).toBe("~/.ssh");
    expect(normalizeProtectedPath("%USERPROFILE%\\.aws", HOME)).toBe("~/.aws");
    expect(normalizeProtectedPath("~/.aws", HOME)).toBe("~/.aws");
  });

  it("resolves . and .. and slashes", () => {
    expect(normalizeProtectedPath("./a/../.env", HOME)).toBe(".env");
    expect(normalizeProtectedPath("src\\..\\.env", HOME)).toBe(".env");
  });

  it("strips Windows trailing dots, spaces and alternate streams", () => {
    expect(normalizeProtectedPath(".env.", HOME)).toBe(".env");
    expect(normalizeProtectedPath(".env ", HOME)).toBe(".env");
    expect(normalizeProtectedPath(".env::$DATA", HOME)).toBe(".env");
    expect(normalizeProtectedPath(".git./hooks/pre-commit", HOME)).toBe(
      ".git/hooks/pre-commit",
    );
    expect(hit(".env.")).toBe("secret");
    expect(hit(".env::$DATA")).toBe("secret");
    expect(hit(".git./hooks/pre-commit")).toBe("config");
    expect(hit("C:\\Users\\me\\.env.")).toBe("secret");
  });

  it("treats an 8.3 short name in a path as protected, but not a git revision", () => {
    expect(hit("GITHUB~1/workflows/x.yml")).toBe("secret");
    expect(hit("HEAD~1")).toBeUndefined();
  });

  it("treats a file URI's /C:/ path like a drive path", () => {
    expect(normalizeProtectedPath("/C:/Users/me/.aws/credentials", HOME)).toBe(
      "~/.aws/credentials",
    );
    expect(hit("/C:/Users/me/.ssh/id_rsa")).toBe("secret");
  });

  it("does not treat another user's home as ours", () => {
    expect(normalizeProtectedPath("C:\\Users\\meagan\\x", HOME)).toBe(
      "C:/Users/meagan/x",
    );
  });

  it("resolves a relative path against the working directory", () => {
    const home = "/home/u";
    expect(
      normalizeProtectedPath("../.aws/credentials", home, "/home/u/proj"),
    ).toBe("~/.aws/credentials");
    expect(
      normalizeProtectedPath(
        "..\\..\\.config\\gh\\hosts.yml",
        home,
        "/home/u/proj/pkg",
      ),
    ).toBe("~/.config/gh/hosts.yml");
    expect(hit("../.aws/credentials")).toBeUndefined();
  });

  it("folds .. and a proc root before comparing to the home directory", () => {
    const home = "/home/u";
    expect(
      normalizeProtectedPath("/home/../home/u/.config/gh/hosts.yml", home),
    ).toBe("~/.config/gh/hosts.yml");
    expect(
      normalizeProtectedPath("/proc/self/root/home/u/.aws/credentials", home),
    ).toBe("~/.aws/credentials");
    expect(
      normalizeProtectedPath("/proc/42/root/home/u/.ssh/config", home),
    ).toBe("~/.ssh/config");
  });

  it("treats a WSL /mnt drive path as the Windows path", () => {
    expect(
      normalizeProtectedPath("/mnt/c/Users/me/.aws/credentials", HOME),
    ).toBe("~/.aws/credentials");
    expect(hit("/mnt/c/users/me/.config/gh/hosts.yml")).toBe("secret");
    expect(hit("/mnt/c/users/me/.kube/config")).toBe("secret");
    expect(hit("/home/someone/.config/gh/hosts.yml")).toBe("secret");
    expect(normalizeProtectedPath("/mnt/cdrom/file", HOME)).toBe(
      "/mnt/cdrom/file",
    );
    expect(hit("/mnt/cdrom/file")).toBeUndefined();
  });

  it("expands ~user next to the home directory", () => {
    expect(normalizeProtectedPath("~u/.aws/credentials", "/home/u")).toBe(
      "~/.aws/credentials",
    );
    expect(normalizeProtectedPath("~other/.ssh/id_rsa", "/home/u")).toBe(
      "/home/other/.ssh/id_rsa",
    );
  });
});

describe("secret paths", () => {
  it.each([
    ".env",
    "app/.env",
    "app/.ENV",
    ".env.local",
    ".env.production",
    "~/.ssh",
    "~/.ssh/id_rsa",
    "~/.aws/credentials",
    "C:\\Users\\me\\.aws\\config",
    "~/.kube/config",
    "~/.gnupg/secring.gpg",
    ".npmrc",
    "deploy/.netrc",
    "keys/id_ed25519",
  ])("%s is secret", (p) => {
    expect(hit(p)).toBe("secret");
  });

  it.each([
    ".env.example",
    ".env.sample",
    "config/.env.template",
    ".environment",
    "env.ts",
    "src/dotenv.ts",
    ".sshconfig-notes.md",
    "docs/ssh.md",
    "other/.ssh/x",
  ])("%s is not", (p) => {
    expect(hit(p)).toBeUndefined();
  });

  it("applies when only the secret list is asked for", () => {
    expect(hit(".env", ["secret"])).toBe("secret");
    expect(hit(".env", ["config"])).toBeUndefined();
  });
});

describe("config paths", () => {
  it.each([
    ".git/config",
    ".git/hooks/pre-commit",
    "sub/.git/HEAD",
    ".GIT/config",
    ".continuous/config.yaml",
    ".vscode/tasks.json",
    ".github/workflows/ci.yml",
    "repo/.GitHub/Workflows/x.yml",
    "~/.bashrc",
    "~/.zshrc",
    ".profile",
  ])("%s is config", (p) => {
    expect(hit(p)).toBe("config");
  });

  it.each([
    ".github/CODEOWNERS",
    ".github/dependabot.yml",
    ".gitignore",
    ".gitattributes",
    "src/git.ts",
    "docs/.vscode-notes.md",
  ])("%s is not", (p) => {
    expect(hit(p)).toBeUndefined();
  });

  it("is ignored when only the secret list is asked for (plain reads)", () => {
    expect(hit(".git/config", ["secret"])).toBeUndefined();
  });

  it("secret wins when a path is both", () => {
    expect(hit(".git/.env")).toBe("secret");
  });
});

describe("protectedReason", () => {
  it("names the path and why", () => {
    expect(
      protectedReason({ kind: "secret", path: "~/.aws/credentials" }),
    ).toMatch(/~\/\.aws\/credentials.*credentials/);
    expect(protectedReason({ kind: "config", path: ".git/hooks/x" })).toMatch(
      /change what runs later/,
    );
  });
});

describe("empty input", () => {
  it("is not protected", () => {
    expect(protectedPathHit(undefined, ["secret"], HOME)).toBeUndefined();
    expect(protectedPathHit("", ["secret"], HOME)).toBeUndefined();
    expect(protectedPathHit("   ", ["secret"], HOME)).toBeUndefined();
  });
});
