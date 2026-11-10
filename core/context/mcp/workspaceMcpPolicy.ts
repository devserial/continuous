/**
 * Workspace MCP servers are commands and URLs that arrived with the folder.
 * They stay off, with secrets removed, until that folder's MCP files are
 * trusted. A server the user already has keeps its name.
 */

import { ConfigValidationError } from "@continuedev/config-yaml";
import * as YAML from "yaml";

import { InternalMcpOptions } from "../..";
import {
  decideFromFiles,
  filesForScope,
  isWorkspaceMcpSource,
  ScopeFile,
  untrustedConfigError,
} from "../../config/projectTrust";

import type { IDE } from "../..";

export function redactUntrustedMcpServer(
  server: InternalMcpOptions,
): InternalMcpOptions {
  const next: InternalMcpOptions = {
    ...server,
    projectTrust: "required",
    configSource: "workspace",
  };
  if ("env" in next && next.env) {
    next.env = Object.fromEntries(
      Object.keys(next.env).map((key) => [key, ""]),
    );
  }
  if ("apiKey" in next) {
    delete next.apiKey;
  }
  if (next.requestOptions?.headers) {
    next.requestOptions = {
      ...next.requestOptions,
      headers: Object.fromEntries(
        Object.keys(next.requestOptions.headers).map((key) => [key, ""]),
      ),
    };
  }
  return next;
}

/**
 * Disabled servers for a workspace MCP block that was not injected, so the
 * file can be shown without rendering secrets.
 */
export function heldMcpServersFromBlock(
  sourceFile: string,
  content: string,
): InternalMcpOptions[] {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    return [];
  }
  const list = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!Array.isArray(list)) return [];
  const servers: InternalMcpOptions[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!name) continue;
    const shared = {
      id: name,
      name,
      sourceFile,
      projectTrust: "required" as const,
      configSource: "workspace" as const,
    };
    if (typeof raw.command === "string") {
      const env =
        raw.env && typeof raw.env === "object"
          ? Object.fromEntries(
              Object.keys(raw.env as object).map((key) => [key, ""]),
            )
          : undefined;
      servers.push({
        ...shared,
        command: raw.command,
        args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
        env,
      });
      continue;
    }
    if (typeof raw.url === "string") {
      if (raw.type === "websocket") {
        servers.push({ ...shared, url: raw.url, type: "websocket" });
      } else if (raw.type === "sse") {
        servers.push({ ...shared, url: raw.url, type: "sse" });
      } else {
        servers.push({ ...shared, url: raw.url, type: "streamable-http" });
      }
    }
  }
  return servers;
}

/**
 * User servers stay. Workspace servers whose name is already taken are
 * dropped. The rest start only when `isTrusted` says the folder's MCP files
 * are trusted; otherwise they are kept disabled with secret values removed.
 */
export function gateWorkspaceMcpServers(
  servers: InternalMcpOptions[],
  workspaceDirs: string[],
  isTrusted: (projectDir: string) => boolean,
): { servers: InternalMcpOptions[]; notices: ConfigValidationError[] } {
  const notices: ConfigValidationError[] = [];
  const user: InternalMcpOptions[] = [];
  const workspace: { server: InternalMcpOptions; dir: string }[] = [];
  for (const server of servers) {
    const dir = workspaceDirs.find((candidate) =>
      isWorkspaceMcpSource(server.sourceFile, [candidate]),
    );
    if (dir) {
      workspace.push({ server, dir });
    } else {
      user.push({ ...server, configSource: server.configSource ?? "user" });
    }
  }

  const taken = new Set(user.map((server) => server.name));
  const kept = [...user];
  const untrustedDirs = new Map<string, number>();

  for (const { server, dir } of workspace) {
    if (taken.has(server.name)) {
      notices.push({
        fatal: false,
        message: `Kept your MCP server "${server.name}" and did not use the one from this folder. A folder cannot replace a server you already have.`,
      });
      continue;
    }
    taken.add(server.name);
    if (server.projectTrust === "required" || !isTrusted(dir)) {
      kept.push(redactUntrustedMcpServer(server));
      untrustedDirs.set(dir, (untrustedDirs.get(dir) ?? 0) + 1);
      continue;
    }
    kept.push({ ...server, configSource: "workspace" });
  }

  for (const [dir, count] of untrustedDirs) {
    const notice = untrustedConfigError(dir, "mcp", count);
    if (notice) notices.push(notice);
  }
  return { servers: kept, notices };
}

/**
 * Trust decision for the MCP files already collected for this load.
 * An empty collection with workspace servers present is not trusted.
 */
/** Whether each workspace folder's MCP files are trusted for this load. */
export async function mcpTrustByDir(
  ide: IDE,
  workspaceDirs: string[],
  servers: InternalMcpOptions[],
): Promise<(dir: string) => boolean> {
  const found = await filesForScope(ide, "mcp");
  const decisions = new Map<string, boolean>();
  for (const dir of workspaceDirs) {
    const files = found.get(dir) ?? [];
    const inDir = servers.filter((server) =>
      isWorkspaceMcpSource(server.sourceFile, [dir]),
    );
    if (files.length > 0) {
      decisions.set(dir, decideFromFiles(dir, "mcp", files).trusted);
    } else if (inDir.length === 0) {
      decisions.set(dir, true);
    } else {
      decisions.set(
        dir,
        decideFromFiles(
          dir,
          "mcp",
          inDir.map((server) => ({
            path: server.sourceFile ?? `${dir}/${server.name}`,
            content: JSON.stringify({
              name: server.name,
              command: "command" in server ? server.command : undefined,
              args: "args" in server ? server.args : undefined,
              url: "url" in server ? server.url : undefined,
            }),
          })),
        ).trusted,
      );
    }
  }
  return (dir) => decisions.get(dir) === true;
}

/**
 * Folder servers do not use the sign-in stored for the user's own server at
 * the same URL. A folder server that sets a proxy, turns TLS checks off, or
 * supplies a CA bundle is not sent a stored token at all.
 */
export function oauthScopeForMcpServer(
  server: InternalMcpOptions,
  workspaceDirs: string[],
): { scope?: string; sendStoredToken: boolean } {
  const workspace =
    server.configSource === "workspace" ||
    server.projectTrust === "required" ||
    isWorkspaceMcpSource(server.sourceFile, workspaceDirs);
  if (!workspace) return { sendStoredToken: true };
  const requestOptions = server.requestOptions;
  const intercepts = !!(
    requestOptions?.proxy ||
    requestOptions?.verifySsl === false ||
    requestOptions?.caBundlePath
  );
  if (server.projectTrust === "required" || intercepts) {
    return { scope: "workspace", sendStoredToken: false };
  }
  return { scope: "workspace", sendStoredToken: true };
}

export function mcpDirIsTrusted(
  projectDir: string,
  files: ScopeFile[],
  hasWorkspaceServers: boolean,
): boolean {
  if (files.length === 0) return !hasWorkspaceServers;
  return decideFromFiles(projectDir, "mcp", files).trusted;
}
