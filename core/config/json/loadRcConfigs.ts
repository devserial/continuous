import * as JSONC from "comment-json";

import { ConfigValidationError } from "@continuedev/config-yaml";

import { ContinueRcJson, IDE } from "../..";

/** Matches core FileType. Importing the enum needs core's type entry at runtime. */
const FILE = 1;
const SYMLINK = 64;
import { scopeIsTrusted, untrustedConfigError } from "../projectTrust";
import { joinPathsToUri } from "../../util/uri";
import { isRcFile } from "../../util/workspaceDirs";

/**
 * Repo-root rc files are merged only after that folder is trusted for their
 * contents. Symlinks are ignored: the target can change without the name
 * changing.
 */
export async function getWorkspaceRcConfigs(ide: IDE): Promise<{
  configs: ContinueRcJson[];
  errors: ConfigValidationError[];
}> {
  const configs: ContinueRcJson[] = [];
  const errors: ConfigValidationError[] = [];
  try {
    const workspaces = await ide.getWorkspaceDirs();
    for (const dir of workspaces) {
      const entries = await ide.listDir(dir);
      const linked = entries.filter(
        ([name, type]) => type === SYMLINK && isRcFile(name),
      );
      if (linked.length > 0) {
        errors.push({
          fatal: false,
          message: `Ignored ${linked.length} symlinked config file${linked.length === 1 ? "" : "s"} in this folder.`,
        });
      }
      const names = entries
        .filter(([name, type]) => type === FILE && isRcFile(name))
        .map(([name]) => name);
      if (names.length === 0) continue;
      const files: { path: string; content: string }[] = [];
      for (const name of names) {
        const uri = joinPathsToUri(dir, name);
        files.push({ path: uri, content: await ide.readFile(uri) });
      }
      const trusted = await scopeIsTrusted(ide, dir, "rc", files);
      if (!trusted) {
        const notice = untrustedConfigError(dir, "rc", files.length);
        if (notice) errors.push(notice);
        continue;
      }
      for (const file of files) {
        configs.push(JSONC.parse(file.content) as unknown as ContinueRcJson);
      }
    }
  } catch (e) {
    console.debug("Failed to load workspace configs: ", e);
  }
  return { configs, errors };
}
