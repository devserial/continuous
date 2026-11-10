import { streamLines } from "../../../diff/util.js";
import { ContinueSDK, SlashCommand } from "../../../index.js";
import { BuiltInToolNames } from "../../../tools/builtIn.js";
import { runTerminalCommandTool } from "../../../tools/definitions/runTerminalCommand.js";
import { evaluateToolPolicyWithRules } from "../../../tools/permissions/evaluate.js";
import { uriToPath } from "../../../tools/permissions/names.js";
import { removeQuotesAndEscapes } from "../../../util/index.js";
import { resolveShell } from "../../../util/shell.js";

/** The same policy the terminal tool uses, so /cmd cannot skip it. */
async function policyForCommand(sdk: ContinueSDK, command: string) {
  const tool =
    sdk.config.tools?.find(
      (t) => t.function?.name === BuiltInToolNames.RunTerminalCommand,
    ) ?? runTerminalCommandTool;
  let cwd: string | undefined;
  try {
    const dirs = await sdk.ide.getWorkspaceDirs();
    cwd = uriToPath(dirs?.[0]);
  } catch {
    cwd = undefined;
  }
  return evaluateToolPolicyWithRules({
    tool,
    toolName: BuiltInToolNames.RunTerminalCommand,
    basePolicy: tool.defaultToolPolicy ?? "allowedWithPermission",
    parsedArgs: { command },
    permissions: sdk.config.toolPermissions,
    cwd,
    shell: resolveShell().kind,
  });
}

const GenerateTerminalCommand: SlashCommand = {
  name: "cmd",
  description: "Generate a shell command",
  run: async function* (sdk) {
    const { ide, llm, input } = sdk;
    if (input.trim() === "") {
      yield "Please provide a description of the shell command you want to generate. For example, '/cmd List all files in the current directory'.";
      return;
    }

    const gen = llm.streamComplete(
      `The user has made a request to run a shell command. Their description of what it should do is:

"${input}"

Please write a shell command that will do what the user requested. Your output should consist of only the command itself, without any explanation or example output. Do not use any newlines. Only output the command that when inserted into the terminal will do precisely what was requested. Here is the command:`,
      new AbortController().signal,
    );

    const lines = streamLines(gen);
    let cmd = "";
    for await (const line of lines) {
      console.log(line);
      if (line.startsWith("```") && line.endsWith("```")) {
        cmd = line.split(" ").slice(1).join(" ").slice(0, -3);
        break;
      }

      if (
        line.startsWith(">") ||
        line.startsWith("``") ||
        line.startsWith("\\begin{") ||
        line.trim() === ""
      ) {
        continue;
      }

      cmd = removeQuotesAndEscapes(line.trim());
      break;
    }

    yield `Generated shell command: ${cmd}`;
    if (!cmd.trim()) return;

    const decision = await policyForCommand(sdk, cmd);
    if (decision.policy === "allowedWithoutPermission") {
      await ide.runCommand(cmd);
      return;
    }
    const why =
      decision.reason ??
      (decision.policy === "disabled"
        ? "Tool policy refused this command."
        : "Tool policy asks before this command runs.");
    yield `\n\nNot run. ${why}`;
  },
};

export default GenerateTerminalCommand;
