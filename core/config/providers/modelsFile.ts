import * as fs from "node:fs";
import * as path from "node:path";

import {
  CatalogModel,
  ConfigValidationError,
  modelsFileSchema,
} from "@continuedev/config-yaml";
import * as YAML from "yaml";

import { IDE } from "../..";
import { getContinueGlobalPath } from "../../util/paths";
import { localPathToUri } from "../../util/pathToUri";
import { joinPathsToUri } from "../../util/uri";
import { externalCatalogModels } from "./externalAccounts";
import { trustedWorkspaceFiles } from "../projectTrust";
import { WORKSPACE_DIRS } from "../../util/workspaceDirs";

export const MODELS_FILE_NAME = "models.yaml";

/** ~/.continuous/models.yaml: the model catalog every config can use. */
export function getGlobalModelsPath(): string {
  return path.join(getContinueGlobalPath(), MODELS_FILE_NAME);
}

/** Parse a models file. A bad file yields no models and an error. */
export function parseModelsFile(
  content: string,
  source: string,
): { models: CatalogModel[]; errors: ConfigValidationError[] } {
  if (content.trim() === "") return { models: [], errors: [] };
  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (e) {
    return {
      models: [],
      errors: [
        {
          fatal: false,
          message: `Could not read ${source}: ${e instanceof Error ? e.message : String(e)}`,
          uri: source,
        },
      ],
    };
  }
  const result = modelsFileSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      models: [],
      errors: [
        {
          fatal: false,
          message: `${source} is not valid: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
          uri: source,
        },
      ],
    };
  }

  const errors: ConfigValidationError[] = [];
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const m of result.data.models) {
    if (seen.has(m.name)) {
      errors.push({
        fatal: false,
        message: `${source} defines the model "${m.name}" twice; the first one is used.`,
        uri: source,
      });
      continue;
    }
    if (m.name.includes("#")) {
      errors.push({
        fatal: false,
        message: `${source}: the model name "${m.name}" contains "#", which picks a variant. The model was skipped.`,
        uri: source,
      });
      continue;
    }
    seen.add(m.name);
    models.push(m);
  }
  return { models, errors };
}

/**
 * The model catalog for loading a config: ~/.continuous/models.yaml, then each
 * workspace's models.yaml once that folder is trusted. A name the user
 * already has is kept; the folder can only add a new name.
 */
export async function loadModelCatalog(
  ide: IDE,
): Promise<{ models: CatalogModel[]; errors: ConfigValidationError[] }> {
  const errors: ConfigValidationError[] = [];
  const byName = new Map<string, CatalogModel>();
  // Models of accounts from the IDE's own settings first; the user's file wins
  for (const m of externalCatalogModels()) byName.set(m.name, m);

  const add = (content: string, source: string) => {
    const parsed = parseModelsFile(content, source);
    errors.push(...parsed.errors);
    for (const m of parsed.models) byName.set(m.name, m);
  };

  const globalPath = getGlobalModelsPath();
  if (fs.existsSync(globalPath)) {
    add(fs.readFileSync(globalPath, "utf8"), localPathToUri(globalPath));
  }

  const workspace: { path: string; content: string }[] = [];
  try {
    for (const dir of await ide.getWorkspaceDirs()) {
      // The older .continue first, so .continuous wins on a new shared name
      for (const name of [...WORKSPACE_DIRS].reverse()) {
        const uri = joinPathsToUri(dir, name, MODELS_FILE_NAME);
        if (await ide.fileExists(uri)) {
          workspace.push({ path: uri, content: await ide.readFile(uri) });
        }
      }
    }
  } catch (e) {
    console.warn("Could not read workspace models.yaml", e);
  }

  const trusted = await trustedWorkspaceFiles(ide, "catalog", workspace);
  errors.push(...trusted.notices);
  const userNames = new Set(byName.keys());
  for (const file of trusted.files) {
    const parsed = parseModelsFile(file.content, file.path);
    errors.push(...parsed.errors);
    for (const model of parsed.models) {
      if (userNames.has(model.name)) {
        errors.push({
          fatal: false,
          message: `Kept your model "${model.name}" and did not use the one from this folder.`,
          uri: file.path,
        });
        continue;
      }
      byName.set(model.name, model);
    }
  }

  return { models: Array.from(byName.values()), errors };
}
