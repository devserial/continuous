import {
  claudeCodeLikeConfigFileSchema,
  claudeDesktopLikeConfigFileSchema,
  ConfigValidationError,
  convertJsonMcpConfigToYamlMcpConfig,
  decodeFQSN,
  McpJsonConfig,
  mcpServersJsonSchema,
  RequestOptions,
} from "@continuedev/config-yaml";
import * as JSONC from "comment-json";
import ignore from "ignore";
import { IDE, InternalMcpOptions } from "../../..";
import { convertYamlMcpConfigToInternalMcpOptions } from "../../../config/yaml/yamlToContinueConfig";
import {
  DEFAULT_IGNORE_DIRS,
  DEFAULT_IGNORE_FILETYPES,
} from "../../../indexing/ignore";
import { walkDir } from "../../../indexing/walkDir";
import { deduplicateArray } from "../../../util";
import { getGlobalFolderWithName } from "../../../util/paths";
import { localPathToUri } from "../../../util/pathToUri";
import { getUriPathBasename, joinPathsToUri } from "../../../util/uri";
import { LocalPlatformClient } from "../../../config/yaml/LocalPlatformClient";
import {
  isWorkspaceMcpSource,
  scopeIsTrusted,
} from "../../../config/projectTrust";
import { WORKSPACE_DIRS } from "../../../util/workspaceDirs";

/**
 * Loads MCP configs from JSON files in ~/.continuous/mcpServers and workspace .continuous/mcpServers
 */
export async function loadJsonMcpConfigs(
  ide: IDE,
  includeGlobal: boolean,
  globalRequestOptions: RequestOptions | undefined = undefined,
): Promise<{
  mcpServers: InternalMcpOptions[];
  errors: ConfigValidationError[];
}> {
  const errors: ConfigValidationError[] = [];

  // Get dirs. The user's global folder is read first, then each workspace,
  // so a shared name keeps the user's server. Within a folder, paths are
  // sorted so the result does not depend on which read finishes first.
  const workspaceDirs = await ide.getWorkspaceDirs();
  const workspaceMcpDirs = workspaceDirs.flatMap((dir) =>
    WORKSPACE_DIRS.map((name) => joinPathsToUri(dir, name, "mcpServers")),
  );
  const globalMcpDir = includeGlobal
    ? localPathToUri(getGlobalFolderWithName("mcpServers"))
    : undefined;

  // Get json files and their contents
  const overrideDefaultIgnores = ignore()
    .add(
      DEFAULT_IGNORE_FILETYPES.filter(
        (val) => !["config.json", "settings.json"].includes(val),
      ),
    )
    .add(DEFAULT_IGNORE_DIRS);

  const jsonFiles: { uri: string; content: string }[] = [];

  const readDir = async (dir: string) => {
    const exists = await ide.fileExists(dir);
    if (!exists) return;
    try {
      const uris = (
        await walkDir(dir, ide, {
          overrideDefaultIgnores,
          source: "get mcp json files",
        })
      )
        .filter((uri) => uri.endsWith(".json"))
        .sort();
      for (const uri of uris) {
        try {
          jsonFiles.push({ uri, content: await ide.readFile(uri) });
        } catch (e) {
          errors.push({
            fatal: false,
            message: `Failed to read MCP server JSON file at ${uri}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    } catch (e) {
      errors.push({
        fatal: false,
        message: `Failed to check for MCP JSON files in ${dir}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  if (globalMcpDir) await readDir(globalMcpDir);
  for (const dir of workspaceMcpDirs) await readDir(dir);

  const validJsonConfigs: {
    name: string;
    mcpJson: McpJsonConfig;
    uri: string;
  }[] = [];
  for (const { content, uri } of jsonFiles) {
    try {
      const json = JSONC.parse(content);
      // Try parsing as a file with mcpServers and multiple servers (claude code/desktop-esque format)
      const claudeCodeFileParsed =
        claudeCodeLikeConfigFileSchema.safeParse(json);
      if (claudeCodeFileParsed.success) {
        if (claudeCodeFileParsed.data.mcpServers) {
          validJsonConfigs.push(
            ...Object.entries(claudeCodeFileParsed.data.mcpServers).map(
              ([name, mcpJson]) => ({
                name,
                mcpJson,
                uri,
              }),
            ),
          );
        }
        const projectServers = Object.values(
          claudeCodeFileParsed.data.projects,
        ).map((v) => v.mcpServers);
        for (const mcpServers of projectServers) {
          if (mcpServers) {
            validJsonConfigs.push(
              ...Object.entries(mcpServers).map(([name, mcpJson]) => ({
                name,
                mcpJson,
                uri,
              })),
            );
          }
        }
      } else {
        const claudeDesktopFileParsed =
          claudeDesktopLikeConfigFileSchema.safeParse(json);
        if (claudeDesktopFileParsed.success) {
          validJsonConfigs.push(
            ...Object.entries(claudeDesktopFileParsed.data.mcpServers).map(
              ([name, mcpJson]) => ({
                name,
                mcpJson,
                uri,
              }),
            ),
          );
        } else {
          // Try parsing as single JSON file
          const singleConfigParsed = mcpServersJsonSchema.safeParse(json);
          if (singleConfigParsed.success) {
            validJsonConfigs.push({
              mcpJson: singleConfigParsed.data,
              name: getUriPathBasename(uri).replace(".json", ""),
              uri,
            });
          } else {
            errors.push({
              fatal: false,
              message: `MCP JSON file at ${uri} doesn't match a supported MCP JSON configuration format`,
            });
          }
        }
      }
    } catch (e) {
      errors.push({
        fatal: false,
        message: `Error parsing MCP JSON file at ${uri}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // De-duplicate
  const deduplicatedJsonConfigs = deduplicateArray(
    validJsonConfigs,
    (a, b) => a.name === b.name,
  );

  // Two levels of conversion for now.
  const yamlConfigs = deduplicatedJsonConfigs.map((c) => {
    const { warnings, yamlConfig } = convertJsonMcpConfigToYamlMcpConfig(
      c.name,
      c.mcpJson,
    );
    return {
      warnings,
      yamlConfig: {
        ...yamlConfig,
        sourceFile: c.uri,
      },
    };
  });

  const mcpServers = yamlConfigs.map((c) => {
    errors.push(
      ...c.warnings.map((warning) => ({
        fatal: false,
        message: warning,
        uri: c.yamlConfig.sourceFile,
      })),
    );
    return convertYamlMcpConfigToInternalMcpOptions(
      c.yamlConfig,
      globalRequestOptions,
    );
  });
  await renderJsonMcpSecrets(ide, mcpServers, workspaceDirs);

  return {
    mcpServers,
    errors,
  };
}

const SECRET_TEMPLATE = /\$\{\{\s*secrets\.([A-Za-z0-9_./-]+)\s*\}\}/g;

/** Fill `${{ secrets.NAME }}` left by the JSON-to-YAML env conversion. */
export async function renderSecretTemplate(
  value: string,
  client: LocalPlatformClient,
): Promise<string> {
  const names = [...value.matchAll(SECRET_TEMPLATE)].map((match) => match[1]);
  if (names.length === 0) return value;
  const results = await client.resolveFQSNs(
    names.map((name) => {
      try {
        return decodeFQSN(name);
      } catch {
        return { packageSlugs: [], secretName: name };
      }
    }),
  );
  let rendered = value;
  for (const result of results) {
    if (!result || !("value" in result)) continue;
    rendered = rendered.replace(
      new RegExp(
        `\\$\\{\\{\\s*secrets\\.${result.fqsn.secretName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`,
        "g",
      ),
      result.value,
    );
  }
  return rendered;
}

/**
 * User MCP JSON files get secret values. A folder file gets them only after
 * that folder is trusted; until then the template is left for the trust gate
 * to drop.
 */
async function renderJsonMcpSecrets(
  ide: IDE,
  servers: InternalMcpOptions[],
  workspaceDirs: string[],
): Promise<void> {
  const client = new LocalPlatformClient(ide);
  for (const server of servers) {
    if (!("env" in server) || !server.env) continue;
    const dir = workspaceDirs.find((candidate) =>
      isWorkspaceMcpSource(server.sourceFile, [candidate]),
    );
    if (dir) {
      const trusted = await scopeIsTrusted(ide, dir, "mcp");
      if (!trusted) continue;
    }
    const rendered: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.env)) {
      rendered[key] = await renderSecretTemplate(value, client);
    }
    server.env = rendered;
  }
}
