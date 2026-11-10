import path from "node:path";

import type { ContinueConfig, Tool } from "../../../";
import { evaluateToolPolicyWithRules } from "../../../tools/permissions/evaluate";
import { readPolicyFile } from "../../../tools/permissions/settingsFile";
import { getContinueGlobalPath } from "../../../util/paths";
import { resolveShell } from "../../../util/shell";

/**
 * Experimental retrieval may run a built-in tool only when the same rules
 * that govern a chat call would let it run without asking. A deny rule, a
 * floor rule or a protected path skips the call. There is nobody to ask.
 */
export function retrievalToolAllowed(
  tool: Tool,
  args: Record<string, unknown>,
  permissions: ContinueConfig["toolPermissions"],
  policyFile?: string,
): boolean {
  const { settings } = readPolicyFile(
    policyFile ?? path.join(getContinueGlobalPath(), "permissions.yaml"),
  );
  const result = evaluateToolPolicyWithRules({
    tool,
    toolName: tool.function.name,
    basePolicy: "allowedWithoutPermission",
    parsedArgs: args,
    permissions,
    approval: {
      levels: settings.levels,
      ...(settings.builtin ? { builtin: settings.builtin } : {}),
      ...(settings.floor?.length ? { floor: settings.floor } : {}),
    },
    shell: resolveShell().kind,
  });
  return result.policy === "allowedWithoutPermission";
}
