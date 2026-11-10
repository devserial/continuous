import {
  ChatCompletion,
  ChatCompletionMessageToolCall,
} from "openai/resources/index";

function completion(options: {
  model: string;
  content: string;
  id?: string;
  toolCalls?: ChatCompletionMessageToolCall[];
  usage?: ChatCompletion["usage"];
  finishReason?: ChatCompletion["choices"][number]["finish_reason"];
}): ChatCompletion {
  const toolCalls = options.toolCalls?.length ? options.toolCalls : undefined;
  return {
    id: options.id ?? "",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    usage: options.usage,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason:
          options.finishReason ?? (toolCalls ? "tool_calls" : "stop"),
        message: {
          role: "assistant",
          content: options.content,
          refusal: null,
          tool_calls: toolCalls,
        },
      },
    ],
  };
}

/** Anthropic Messages body from Vertex, including every text part and tool use. */
export function anthropicResponseToChatCompletion(
  data: any,
  model: string,
): ChatCompletion {
  const parts = Array.isArray(data?.content) ? data.content : [];
  const texts: string[] = [];
  const toolCalls: ChatCompletionMessageToolCall[] = [];
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    } else if (part?.type === "tool_use") {
      toolCalls.push({
        id: typeof part.id === "string" ? part.id : "",
        type: "function",
        function: {
          name: typeof part.name === "string" ? part.name : "",
          arguments: JSON.stringify(part.input ?? {}),
        },
      });
    }
  }
  const input = data?.usage?.input_tokens ?? 0;
  const output = data?.usage?.output_tokens ?? 0;
  return completion({
    id: data?.id,
    model,
    content: texts.join(""),
    toolCalls,
    usage: data?.usage
      ? {
          prompt_tokens: input,
          completion_tokens: output,
          total_tokens: input + output,
        }
      : undefined,
  });
}

/** Gemini generateContent body from Vertex. */
export function geminiResponseToChatCompletion(
  data: any,
  model: string,
): ChatCompletion {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const texts: string[] = [];
  const toolCalls: ChatCompletionMessageToolCall[] = [];
  for (const part of parts) {
    if (typeof part?.text === "string" && part.text) {
      texts.push(part.text);
    }
    if (part?.functionCall) {
      toolCalls.push({
        id:
          typeof part.functionCall.id === "string"
            ? part.functionCall.id
            : `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: part.functionCall.name ?? "",
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }
  const meta = data?.usageMetadata;
  return completion({
    model,
    content: texts.join(""),
    toolCalls,
    usage: meta
      ? {
          prompt_tokens: meta.promptTokenCount ?? 0,
          completion_tokens: meta.candidatesTokenCount ?? 0,
          total_tokens:
            meta.totalTokenCount ??
            (meta.promptTokenCount ?? 0) + (meta.candidatesTokenCount ?? 0),
        }
      : undefined,
  });
}

/** Mistral rawPredict already speaks the OpenAI chat shape. */
export function openAiStyleResponseToChatCompletion(
  data: any,
  model: string,
): ChatCompletion {
  const choice = data?.choices?.[0];
  const message = choice?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : undefined;
  return completion({
    id: data?.id,
    model: data?.model ?? model,
    content: typeof message.content === "string" ? message.content : "",
    toolCalls,
    usage: data?.usage,
    finishReason: choice?.finish_reason,
  });
}
