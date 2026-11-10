import type { ExternalAccount } from "core/config/providers/externalAccounts";
import type {
  AssistantChatMessage,
  ChatMessage,
  ILLM,
  Tool,
  ToolCallDelta,
} from "core";
import { countTokens } from "core/llm/countTokens";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { renderChatMessage } from "core/util/messageContent";
import * as vscode from "vscode";

/** Must match contributes.languageModelChatProviders[].vendor in package.json. */
export const LM_VENDOR = "continuous";

const DEFAULT_CONTEXT_LENGTH = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;

interface ContinuedModelInfo extends vscode.LanguageModelChatInformation {
  /** The title of the Continuous model this entry stands for. */
  readonly llmTitle: string;
}

/**
 * Offers the chat models of the selected Continuous config, then the rest of
 * the model catalog (models.yaml, each variant too), to VS Code's chat and
 * agents. Requests run through Continuous's own LLM classes, so they use the
 * keys and settings from the config and providers.yaml; keys never pass to
 * VS Code.
 */
export class ContinuedLanguageModelChatProvider implements vscode.LanguageModelChatProvider<ContinuedModelInfo> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;

  private models: ILLM[] = [];
  private enabled = true;

  /**
   * Set when accounts from VS Code's Language Models editor are on: takes
   * a group's configuration, makes it an account (reloading the config when
   * it changed) and returns the account's name.
   */
  onGroupConfiguration?: (
    configuration: Record<string, unknown>,
  ) => Promise<string | undefined>;

  /**
   * Called when the config reloads: the config's chat models, and the
   * catalog models it does not use (ContinueConfig.offeredModels).
   */
  update(chatModels: ILLM[] | undefined, offeredModels?: ILLM[]) {
    const next = [...(chatModels ?? []), ...(offeredModels ?? [])];
    const key = (list: ILLM[]) =>
      list.map((m) => `${m.title}|${m.providerName}|${m.model}`).join(",");
    if (key(next) === key(this.models)) {
      this.models = next; // same models, fresh instances
      return;
    }
    this.models = next;
    this.changed.fire();
  }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.changed.fire();
  }

  async provideLanguageModelChatInformation(
    options?: vscode.PrepareLanguageModelChatModelOptions,
  ): Promise<ContinuedModelInfo[]> {
    if (!this.enabled) return [];
    let models = this.models;
    // A group from the Language Models editor (proposed; see package.json)
    const configuration = (
      options as { configuration?: Record<string, unknown> } | undefined
    )?.configuration;
    if (configuration && Object.keys(configuration).length) {
      // The models served through the group's account
      const account = await this.onGroupConfiguration?.(configuration);
      if (!account) return [];
      models = this.models.filter(
        (m) =>
          (m as { routeName?: string }).routeName === account ||
          m.routeNames?.includes(account),
      );
    }
    const seen = new Set<string>();
    return models.flatMap((llm) => {
      const title = llm.title ?? llm.model;
      if (seen.has(title)) return [];
      seen.add(title);
      return [modelInfo(llm, title)];
    });
  }

  async provideLanguageModelChatResponse(
    model: ContinuedModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const llm = this.findModel(model);
    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    try {
      const tools = options.tools?.length
        ? options.tools.map(toContinuedTool)
        : undefined;
      const toolCalls = new ToolCallCollector();
      for await (const chunk of llm.streamChat(
        toChatMessages(messages),
        abort.signal,
        {
          ...(tools ? { tools } : {}),
          // Continuous can force one named tool, not "any tool": honour
          // Required mode when exactly one tool is offered.
          ...(tools?.length === 1 &&
          options.toolMode === vscode.LanguageModelChatToolMode.Required
            ? {
                toolChoice: {
                  type: "function" as const,
                  function: { name: tools[0].function.name },
                },
              }
            : {}),
        },
      )) {
        if (token.isCancellationRequested) break;
        if (chunk.role !== "assistant") continue; // thinking and others
        const text = renderChatMessage(chunk);
        if (text) progress.report(new vscode.LanguageModelTextPart(text));
        for (const delta of (chunk as AssistantChatMessage).toolCalls ?? []) {
          toolCalls.add(delta);
        }
      }
      for (const call of toolCalls.finish()) {
        progress.report(
          new vscode.LanguageModelToolCallPart(call.id, call.name, call.input),
        );
      }
    } finally {
      sub.dispose();
    }
  }

  async provideTokenCount(
    model: ContinuedModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
  ): Promise<number> {
    const llm = this.models.find(
      (m) => (m.title ?? m.model) === model.llmTitle,
    );
    const content =
      typeof text === "string"
        ? text
        : toChatMessages([text])
            .map((m) => renderChatMessage(m))
            .join("\n");
    return countTokens(content, llm?.model ?? model.version);
  }

  private findModel(model: ContinuedModelInfo): ILLM {
    const llm = this.models.find(
      (m) => (m.title ?? m.model) === model.llmTitle,
    );
    if (!llm) {
      throw new Error(
        `${model.name} is no longer in the selected Continuous config.`,
      );
    }
    return llm;
  }

  dispose() {
    this.changed.dispose();
  }
}

export function modelInfo(llm: ILLM, title: string): ContinuedModelInfo {
  const maxOutputTokens =
    llm.completionOptions?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const contextLength = llm.contextLength ?? DEFAULT_CONTEXT_LENGTH;
  const toolCalling = modelSupportsNativeTools({
    title,
    provider: llm.underlyingProviderName ?? llm.providerName,
    model: llm.model,
    capabilities: llm.capabilities,
  } as any);
  const routes = llm.routeNames;
  return {
    id: title,
    llmTitle: title,
    name: title,
    family: llm.providerName,
    version: llm.model,
    detail: "Continuous",
    tooltip: `${llm.providerName} · ${llm.model}${
      routes ? ` (routes: ${routes.join(", ")})` : ""
    } (from your Continuous setup)`,
    maxInputTokens: Math.max(1, contextLength - maxOutputTokens),
    maxOutputTokens,
    capabilities: { toolCalling: !!toolCalling, imageInput: false },
    // Proposed chatProvider API (the agents build declares it; elsewhere
    // VS Code ignores these): the model runs on the user's own accounts,
    // which is what the Agents window forwards to its agent sessions, and
    // it can be picked in the model picker.
    ...({ isBYOK: true, isUserSelectable: true } as object),
  };
}

/** VS Code request messages to Continuous chat messages. */
export function toChatMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    let text = "";
    const toolCalls: { id: string; name: string; input: object }[] = [];
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({ id: part.callId, name: part.name, input: part.input });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        // Tool results become their own "tool" messages, in order.
        if (text) {
          out.push({ role: "user", content: text });
          text = "";
        }
        out.push({
          role: "tool",
          toolCallId: part.callId,
          content: part.content
            .map((c) =>
              c instanceof vscode.LanguageModelTextPart
                ? c.value
                : typeof c === "string"
                  ? c
                  : JSON.stringify(c),
            )
            .join(""),
        });
      }
    }
    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      out.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length
          ? {
              toolCalls: toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      });
    } else if (text) {
      out.push({ role: "user", content: text });
    }
  }
  return out;
}

export function toContinuedTool(tool: vscode.LanguageModelChatTool): Tool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (tool.inputSchema as Record<string, any>) ?? {
        type: "object",
        properties: {},
      },
    },
    displayTitle: tool.name,
    readonly: false,
    group: "VS Code",
  };
}

/**
 * Tool calls stream in as deltas: the first names the call, later ones add
 * argument text. A delta with an index continues that call. A delta with
 * neither continues the previous call.
 */
export class ToolCallCollector {
  private calls: { id: string; index?: number; name: string; args: string }[] =
    [];

  private append(
    call: { name: string; args: string },
    delta: ToolCallDelta,
  ): void {
    if (delta.function?.name && !call.name) call.name = delta.function.name;
    if (delta.function?.arguments) call.args += delta.function.arguments;
  }

  private find(delta: ToolCallDelta) {
    if (delta.id) {
      const byId = this.calls.find((c) => c.id === delta.id);
      if (byId) return byId;
    }
    if (typeof delta.index === "number") {
      return this.calls.find((c) => c.index === delta.index);
    }
    // A new id starts a call. With neither id nor index, fragments continue
    // the previous call.
    if (delta.id) return undefined;
    return this.calls[this.calls.length - 1];
  }

  add(delta: ToolCallDelta) {
    const match = this.find(delta);
    if (match) {
      if (delta.id) match.id = delta.id;
      if (typeof delta.index === "number") match.index = delta.index;
      this.append(match, delta);
      return;
    }
    this.calls.push({
      id: delta.id || `call_${this.calls.length}`,
      ...(typeof delta.index === "number" ? { index: delta.index } : {}),
      name: delta.function?.name ?? "",
      args: delta.function?.arguments ?? "",
    });
  }

  finish(): { id: string; name: string; input: object }[] {
    return this.calls
      .filter((c) => c.name)
      .map((c) => {
        let input: object = {};
        try {
          const parsed = c.args.trim() ? JSON.parse(c.args) : {};
          input = parsed && typeof parsed === "object" ? parsed : {};
        } catch {
          input = {};
        }
        return { id: c.id, name: c.name, input };
      });
  }
}

const ACCOUNT_NAME = /[^A-Za-z0-9_.-]+/g;

/**
 * A group from VS Code's Language Models editor as a Continuous account and
 * the catalog models it offers. Undefined without a provider.
 */
export function groupToAccount(
  configuration: Record<string, unknown>,
): ({ name: string } & ExternalAccount) | undefined {
  const str = (k: string) =>
    typeof configuration[k] === "string" && configuration[k]
      ? (configuration[k] as string).trim()
      : undefined;
  const provider = str("provider");
  if (!provider) return undefined;
  const name = (str("name") ?? `${provider}-vscode`).replace(ACCOUNT_NAME, "-");
  const region = str("region");
  const account: ExternalAccount["account"] = {
    name,
    provider,
    ...(str("apiKey") ? { apiKey: str("apiKey") } : {}),
    ...(str("apiBase") ? { apiBase: str("apiBase") } : {}),
    ...(region ? { env: { region } } : {}),
  };
  const ids = Array.isArray(configuration.models)
    ? configuration.models.filter(
        (m): m is string => typeof m === "string" && m.trim() !== "",
      )
    : [];
  const models: ExternalAccount["models"] = ids.map((id) => ({
    name: `${id.trim()} (${name})`.replace(/#/g, "-"),
    model: id.trim(),
    connection: name,
  }));
  return { name, account, models };
}
