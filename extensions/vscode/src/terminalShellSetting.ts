import { setTerminalShellPreference } from "core/util/shell";
import {
  wslStatus,
  wslUnavailableMessage,
  WSL_INSTALL_COMMAND,
} from "core/util/wslStatus";
import * as vscode from "vscode";

const SHELL = "continuous.terminal.shell";
const DISTRO = "continuous.terminal.wslDistro";
const INSTALL_GUIDE = "https://learn.microsoft.com/windows/wsl/install";

/**
 * Where the agent's terminal commands run: the host's own shell, or, on
 * Windows, bash inside a WSL distribution (plans/isolation.md, W1). Core runs
 * in this process and reads the choice from `core/util/shell`, so the setting
 * is applied now and again whenever it changes.
 *
 * WSL is only offered where it exists. Off Windows the setting is ignored and
 * said so; on Windows without a distribution the person is told how to install
 * one, once per change, with the command to copy. Nothing is installed or run
 * for them (the install needs an administrator terminal and a restart), and
 * commands never fall back to the host's shell while WSL is wanted but absent.
 */
export function registerTerminalShellSetting(
  context: vscode.ExtensionContext,
): void {
  let told: string | undefined;

  const tell = async (distro: string | undefined) => {
    const message = wslUnavailableMessage(wslStatus(distro));
    if (!message || told === message) return;
    told = message;
    if (process.platform !== "win32") {
      void vscode.window.showInformationMessage(message);
      return;
    }
    const copy = "Copy install command";
    const guide = "Open install guide";
    const choice = await vscode.window.showWarningMessage(
      message.split(". ")[0] + ".",
      copy,
      guide,
    );
    if (choice === copy) {
      await vscode.env.clipboard.writeText(WSL_INSTALL_COMMAND);
    } else if (choice === guide) {
      await vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE));
    }
  };

  const apply = () => {
    const config = vscode.workspace.getConfiguration();
    // Machine settings. Only the user value is read, so a workspace
    // .vscode/settings.json cannot choose where commands run.
    const shell = config.inspect<string>(SHELL)?.globalValue;
    if (shell === "wsl") {
      const distro = (config.inspect<string>(DISTRO)?.globalValue ?? "").trim();
      setTerminalShellPreference(
        distro ? { kind: "wsl", distro } : { kind: "wsl" },
      );
      void tell(distro || undefined);
    } else {
      told = undefined;
      setTerminalShellPreference(undefined);
    }
  };
  apply();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SHELL) || e.affectsConfiguration(DISTRO)) {
        apply();
      }
    }),
  );
}
