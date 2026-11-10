import { randomBytes, timingSafeEqual } from "node:crypto";

import chalk from "chalk";
import type { ChatHistoryItem, Session, ToolStatus } from "core/index.js";
import { createHistoryItem } from "core/util/messageConversion.js";
import type { Express, NextFunction, Request, Response } from "express";

import {
  describePromptBlocked,
  runUserPromptSubmitHooks,
} from "../hooks/promptHook.js";
import { withLoopSteering } from "../loop/loopSession.js";
import { services } from "../services/index.js";
import {
  mergeQueuedMessages,
  MessageQueue,
  messageQueue,
} from "../stream/messageQueue.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";
import { StreamCallbacks } from "../stream/streamChatResponse.types.js";
import { logger } from "../util/logger.js";

/**
 * Where `cn serve` listens, and who may talk to it (plans/policy-areas.md,
 * "cn serve"). The server takes messages, approvals and loop answers, and
 * will take the policy levels, so anything that can reach the port can act
 * as the person. It listens on loopback unless told otherwise. Every request
 * carries a bearer token, generated and printed when `--token` is omitted.
 * On loopback the Host header must be a loopback name or address, and a
 * request that carries an Origin header is refused.
 */

export const DEFAULT_SERVE_HOST = "127.0.0.1";

/** True for an address only this computer can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/**
 * Why the server must not start with these options, or undefined when it
 * may. A missing token is filled in with a generated one. An explicit token
 * shorter than 16 characters is refused when the host is not loopback.
 */
export function serveBindingProblem(
  host: string,
  token: string | undefined,
): string | undefined {
  const trimmed = token?.trim() ?? "";
  if (!trimmed || isLoopbackHost(host) || trimmed.length >= 16) {
    return undefined;
  }
  return `--host ${host} listens beyond this computer, so --token must be at least 16 characters.`;
}

/**
 * The token every request must carry. An omitted or blank `--token` is
 * replaced with a generated one, which the server prints at startup.
 */
export function resolveServeToken(
  token: string | undefined,
  generate: () => string = () => randomBytes(24).toString("base64url"),
): { token: string; generated: boolean } {
  const trimmed = token?.trim() ?? "";
  if (trimmed) return { token: trimmed, generated: false };
  return { token: generate(), generated: true };
}

/** The host from a Host header, without a port and without IPv6 brackets. */
export function hostHeaderName(hostHeader: string | undefined): string {
  const raw = (hostHeader ?? "").trim();
  if (!raw) return "";
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
  if (bracketed) return bracketed[1];
  // A single colon is host:port. More than one is an IPv6 address.
  const port = /:(\d+)$/.exec(raw);
  if (port && raw.indexOf(":") === raw.lastIndexOf(":")) {
    return raw.slice(0, -port[0].length);
  }
  return raw;
}

const UNSPECIFIED_HOSTS = new Set([
  "0.0.0.0",
  "::",
  "https://example.org/m/orchid",
]);

/**
 * Whether this request's Host header is the interface the server bound.
 * On loopback, only a loopback name or address is accepted.
 */
export function hostHeaderAllowed(
  hostHeader: string | undefined,
  boundHost: string,
): boolean {
  const presented = hostHeaderName(hostHeader);
  if (!presented) return false;
  if (isLoopbackHost(boundHost)) return isLoopbackHost(presented);
  const bound = boundHost
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (UNSPECIFIED_HOSTS.has(bound)) return true;
  return presented.toLowerCase() === bound;
}

/** A browser sends Origin. curl and other local clients do not. */
export function originHeaderAllowed(origin: string | undefined): boolean {
  return origin === undefined || origin.trim() === "";
}

export interface ServeRequestProblem {
  status: 421 | 403;
  error: string;
}

/**
 * Why this request must be refused before it is authenticated, or undefined
 * when the Host and Origin headers are acceptable.
 */
export function serveRequestProblem(
  headers: { host?: string; origin?: string },
  boundHost: string,
): ServeRequestProblem | undefined {
  if (!hostHeaderAllowed(headers.host, boundHost)) {
    return {
      status: 421,
      error: isLoopbackHost(boundHost)
        ? "The Host header must be the loopback name or address this server is bound to."
        : "The Host header must match the address this server is bound to.",
    };
  }
  if (!originHeaderAllowed(headers.origin)) {
    return {
      status: 403,
      error: "Requests that carry an Origin header are refused.",
    };
  }
  return undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Refuse a request whose Host is not the bound loopback name or address, or
 * that carries an Origin header, then require the bearer token.
 */
export function installServeGuards(
  app: Express,
  options: { boundHost: string; token: string },
): void {
  const { boundHost, token } = options;
  app.use((req: Request, res: Response, next: NextFunction) => {
    const problem = serveRequestProblem(
      {
        host: headerValue(req.headers.host),
        origin: headerValue(req.headers.origin),
      },
      boundHost,
    );
    if (problem) {
      res.status(problem.status).json({ error: problem.error });
      return;
    }
    next();
  });
  app.use(bearerTokenMiddleware(token));
}

/** Whether a request's Authorization header carries the token, compared in constant time. */
export function authorizeRequest(
  authorization: string | undefined,
  token: string,
): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Express middleware: every request must carry the token. */
export function bearerTokenMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (authorizeRequest(req.header("authorization"), token)) {
      next();
      return;
    }
    res.status(401).json({ error: "A bearer token is required." });
  };
}

/**
 * Remove partial assistant message if the last message is an empty assistant message.
 * Used when a response is interrupted.
 */
export function removePartialAssistantMessage(
  sessionHistory: ChatHistoryItem[],
): void {
  try {
    const svcHistory = services.chatHistory.getHistory();
    const last = svcHistory[svcHistory.length - 1];
    if (last && last.message.role === "assistant" && !last.message.content) {
      services.chatHistory.setHistory(svcHistory.slice(0, -1));
    }
  } catch {
    const lastMessage = sessionHistory[sessionHistory.length - 1];
    if (
      lastMessage &&
      lastMessage.message.role === "assistant" &&
      !lastMessage.message.content
    ) {
      sessionHistory.pop();
    }
  }
}

/**
 * The tool-boundary callback for serve: when a client steered (POST /message
 * with `steer: true`), take the queued plain messages, run them through the
 * UserPromptSubmit hooks as the end of a turn would, and return them as one
 * user message to append after the tool results. A blocked message is
 * answered with a system message, so whoever watches the session sees why.
 */
export async function buildServeSteeringMessage(
  queue: MessageQueue = messageQueue,
): Promise<ChatHistoryItem | undefined> {
  const merged = mergeQueuedMessages(queue.takeSteerMessages());
  if (!merged) return undefined;

  const promptHook = await runUserPromptSubmitHooks(merged.message);
  if (promptHook.blockedReason) {
    try {
      services.chatHistory.addSystemMessage(
        describePromptBlocked(promptHook.blockedReason),
      );
    } catch {
      logger.warn(`A hook blocked a message: ${promptHook.blockedReason}`);
    }
    return undefined;
  }
  return createHistoryItem({ role: "user", content: promptHook.prompt }, []);
}

// Modified version of streamChatResponse that supports interruption
export async function streamChatResponseWithInterruption(
  state: ServerState,
  llmApi: any,
  abortController: AbortController,
  shouldInterrupt: () => boolean,
): Promise<string> {
  // Import the original streamChatResponse logic but add interruption checks
  // Create a wrapper that checks for interruption
  const originalSignal = abortController.signal;
  const checkInterruption = () => {
    if (shouldInterrupt() && !originalSignal.aborted) {
      abortController.abort();
    }
  };

  // Set up periodic interruption checks
  const interruptionChecker = setInterval(checkInterruption, 100);

  // Create callbacks to capture tool events
  const callbacks: StreamCallbacks = {
    onContent: (_: string) => {
      // onContent is empty - doesn't update history during streaming
      // This is just for real-time display purposes
    },
    onContentComplete: (_: string) => {
      // Note: streamChatResponse already adds messages to history via handleToolCalls
      // so we don't need to add them here - this callback is just for notification
      // that content streaming is complete
    },
    onToolStart: (__: string, _?: any) => {
      // Note: handleToolCalls already adds the tool call message to history
      // This callback is just for notification/UI updates
      // The tool call state is already created and added by handleToolCalls
    },
    onToolResult: (_result: string, _toolName: string, _status: ToolStatus) => {
      // No-op when using ChatHistoryService; it updates tool states/results
    },
    onToolError: (_error: string, _toolName?: string) => {
      // No-op; errors are added to history via handleToolCalls flow
    },
    onToolPermissionRequest: (
      toolName: string,
      toolArgs: any,
      requestId: string,
      toolCallPreview?: any[],
    ) => {
      // Set pending permission state
      state.pendingPermission = {
        toolName,
        toolArgs,
        requestId,
        timestamp: Date.now(),
        toolCallPreview,
      };

      // Add a system message indicating permission is needed via service
      try {
        services.chatHistory.addSystemMessage(
          `WARNING: Tool ${toolName} requires permission`,
        );
      } catch (err) {
        // Do not mutate session history; ChatHistoryService is the source of truth
        logger.error(
          "Failed to add system message via ChatHistoryService",
          err,
          { context: "onToolPermissionRequest", toolName, requestId },
        );
      }

      // Don't wait here - the streamChatResponse will handle waiting
    },
    onSystemMessage: (message: string) => {
      try {
        services.chatHistory.addSystemMessage(message);
      } catch (err) {
        // Do not mutate session history; ChatHistoryService is the source of truth
        logger.error(
          "Failed to add system message via ChatHistoryService",
          err,
          { context: "onSystemMessage" },
        );
      }
    },
    // Steering: a message posted with `steer: true` while this run works is
    // delivered here, between the tool results and the next model request.
    // Loop mode's answers for the running item go in at the same boundary.
    onToolBoundary: withLoopSteering(() => buildServeSteeringMessage()),
    // A notice for whoever watches the server (a reply cut off at the output
    // limit, say): the TUI puts it on its status line, serve logs it.
    onStatusMessage: (message: string) => {
      logger.info(chalk.yellow(message));
    },
  };

  try {
    const response = await streamChatResponse(
      state.session.history,
      state.model,
      llmApi,
      abortController,
      callbacks,
    );
    return response || "";
  } finally {
    clearInterval(interruptionChecker);
  }
}

export interface PendingPermission {
  toolName: string;
  toolArgs: any;
  requestId: string;
  timestamp: number;
  toolCallPreview?: any[];
}

export interface ServerState {
  session: Session;
  config: any;
  model: any;
  isProcessing: boolean;
  lastActivity: number;
  currentAbortController: AbortController | null;
  serverRunning: boolean;
  pendingPermission: PendingPermission | null;
  systemMessage?: string;
}

/**
 * Check if the agent should be marked as complete based on conversation history.
 * The agent is complete if the last message is from the assistant and has no tool calls.
 */
export function checkAgentComplete(
  history: { message: { role: string; tool_calls?: any[] } }[] | undefined,
): boolean {
  if (!history || history.length === 0) {
    return false;
  }
  const lastItem = history[history.length - 1];
  if (lastItem?.message?.role !== "assistant") {
    return false;
  }
  const toolCalls = (lastItem.message as any).tool_calls;
  return !toolCalls || toolCalls.length === 0;
}
