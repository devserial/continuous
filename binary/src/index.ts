process.env.IS_BINARY = "true";
import { Command } from "commander";
import { Core } from "core/core";
import { LLMLogFormatter } from "core/llm/logFormatter";
import { FromCoreProtocol, ToCoreProtocol } from "core/protocol";
import { IMessenger } from "core/protocol/messenger";
import { getCoreLogsPath, getPromptLogsPath } from "core/util/paths";
import fs from "node:fs";
import { IpcIde } from "./IpcIde";
import { IpcMessenger } from "./IpcMessenger";
import { setupCoreLogging } from "./logging";
import { TcpMessenger } from "./TcpMessenger";

const logFilePath = getCoreLogsPath();
fs.appendFileSync(logFilePath, "[info] Starting Continue core...\n");

const program = new Command();

program.action(async () => {
  try {
    let messenger: IMessenger<ToCoreProtocol, FromCoreProtocol>;
    if (process.env.CONTINUE_DEVELOPMENT === "true") {
      const devMessenger = new TcpMessenger<ToCoreProtocol, FromCoreProtocol>();
      messenger = devMessenger;
      if (devMessenger.tokenGenerated) {
        console.log(`[binary] Dev control token: ${devMessenger.token}`);
        console.log(
          "[binary] Set CONTINUE_TCP_TOKEN in the connecting process to this value.",
        );
      }
      console.log("[binary] Waiting for an authenticated connection");
      await (
        messenger as TcpMessenger<ToCoreProtocol, FromCoreProtocol>
      ).awaitConnection();
      console.log("[binary] Connected");
    } else {
      setupCoreLogging();
      // await setupCa();
      messenger = new IpcMessenger<ToCoreProtocol, FromCoreProtocol>();
    }
    const ide = new IpcIde(messenger);
    const promptLogsPath = getPromptLogsPath();

    const core = new Core(messenger, ide);
    new LLMLogFormatter(core.llmLogger, fs.createWriteStream(promptLogsPath));

    console.log("[binary] Core started");
  } catch (e) {
    fs.writeFileSync("./error.log", `${new Date().toISOString()} ${e}\n`);
    console.log("Error: ", e);
    process.exit(1);
  }
});

program.parse(process.argv);
