import { randomBytes, timingSafeEqual } from "node:crypto";
import { IProtocol } from "core/protocol";
import { IMessenger, Message } from "core/protocol/messenger";
import net from "net";
import { v4 as uuidv4 } from "uuid";

/** Dev control port. It is only reachable on this machine. */
export const DEV_TCP_HOST = "127.0.0.1";
export const DEV_TCP_PORT = 3000;
/** Shared with the IDE process that connects. */
export const DEV_TCP_TOKEN_ENV = "CONTINUE_TCP_TOKEN";
const AUTH_MESSAGE_TYPE = "tcpAuth";
const MAX_AUTH_BYTES = 4096;

/**
 * The token for the dev control port. A blank value is replaced with a
 * generated one, which the process prints. A short explicit value is refused.
 */
export function resolveDevTcpToken(value: string | undefined): {
  token: string;
  generated: boolean;
} {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return { token: randomBytes(24).toString("base64url"), generated: true };
  }
  if (trimmed.length < 16) {
    throw new Error(`${DEV_TCP_TOKEN_ENV} must be at least 16 characters.`);
  }
  return { token: trimmed, generated: false };
}

/** The first line a client sends. The line ends with CR LF. */
export function devTcpAuthLine(token: string): string {
  return (
    JSON.stringify({
      messageType: AUTH_MESSAGE_TYPE,
      messageId: "auth",
      data: token,
    }) + "\r\n"
  );
}

function tokensEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** Whether this line is the auth line for the token. */
export function devTcpAuthLineMatches(line: string, token: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const message = parsed as { messageType?: unknown; data?: unknown };
  if (
    message.messageType !== AUTH_MESSAGE_TYPE ||
    typeof message.data !== "string"
  ) {
    return false;
  }
  return tokensEqual(message.data, token);
}

export class TcpMessenger<
  ToProtocol extends IProtocol,
  FromProtocol extends IProtocol,
> implements IMessenger<ToProtocol, FromProtocol> {
  private port: number;
  private socket: net.Socket | null = null;
  private server: net.Server;
  private buffers = new Map<net.Socket, string>();
  private retired = new WeakSet<net.Socket>();
  readonly token: string;
  readonly tokenGenerated: boolean;
  readonly ready: Promise<void>;

  typeListeners = new Map<keyof ToProtocol, ((message: Message) => any)[]>();
  idListeners = new Map<string, (message: Message) => any>();

  constructor(options?: { port?: number; token?: string }) {
    this.port = options?.port ?? DEV_TCP_PORT;
    const resolved = resolveDevTcpToken(
      options && "token" in options
        ? options.token
        : process.env[DEV_TCP_TOKEN_ENV],
    );
    this.token = resolved.token;
    this.tokenGenerated = resolved.generated;

    let settled = false;
    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.ready = new Promise((resolve, reject) => {
      this.server.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        console.error("[binary] Dev control port error:", err);
      });
      this.server.listen(this.port, DEV_TCP_HOST, () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  /** The address the server actually bound, once `ready` has resolved. */
  address(): { address: string; port: number } | null {
    const addr = this.server.address();
    if (!addr || typeof addr === "string") return null;
    return { address: addr.address, port: addr.port };
  }

  close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    for (const pending of this.buffers.keys()) pending.destroy();
    this.buffers.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleConnection(socket: net.Socket) {
    this.buffers.set(socket, "");
    socket.on("data", (data: Buffer) => {
      if (this.retired.has(socket)) return;
      if (socket === this.socket) {
        this._handleData(data);
        return;
      }
      this.handleAuthData(socket, data);
    });
    const forget = () => {
      this.buffers.delete(socket);
      if (this.socket === socket) this.socket = null;
    };
    socket.on("end", () => {
      if (this.socket === socket) console.log("Disconnected from server");
      forget();
    });
    socket.on("close", forget);
    socket.on("error", (err: Error) => {
      if (socket === this.socket) console.error("Client error:", err);
      forget();
    });
  }

  private handleAuthData(socket: net.Socket, data: Buffer) {
    const buffered = (this.buffers.get(socket) ?? "") + data.toString("utf8");
    const splitAt = buffered.indexOf("\r\n");
    if (splitAt === -1) {
      if (buffered.length > MAX_AUTH_BYTES) {
        this.buffers.delete(socket);
        socket.destroy();
        return;
      }
      this.buffers.set(socket, buffered);
      return;
    }
    const line = buffered.slice(0, splitAt);
    const rest = buffered.slice(splitAt + 2);
    this.buffers.delete(socket);
    if (!devTcpAuthLineMatches(line, this.token)) {
      socket.destroy();
      return;
    }
    const previous = this.socket;
    this._unfinishedLine = undefined;
    this.socket = socket;
    if (previous && previous !== socket) {
      this.retired.add(previous);
      previous.destroy();
    }
    if (rest.length > 0) this._handleData(Buffer.from(rest, "utf8"));
  }

  private _onErrorHandlers: ((message: Message, error: Error) => void)[] = [];

  onError(handler: (message: Message, error: Error) => void) {
    this._onErrorHandlers.push(handler);
  }

  public async awaitConnection() {
    while (!this.socket) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private _handleLine(line: string) {
    try {
      const msg: Message = JSON.parse(line);
      if (msg.messageType === undefined || msg.messageId === undefined) {
        throw new Error("Invalid message sent: " + JSON.stringify(msg));
      }

      // Call handler and respond with return value
      const listeners = this.typeListeners.get(msg.messageType as any);
      listeners?.forEach(async (handler) => {
        try {
          const response = await handler(msg);
          if (
            response &&
            typeof response[Symbol.asyncIterator] === "function"
          ) {
            let next = await response.next();
            while (!next.done) {
              this.send(
                msg.messageType,
                {
                  done: false,
                  content: next.value,
                  status: "success",
                },
                msg.messageId,
              );
              next = await response.next();
            }
            this.send(
              msg.messageType,
              {
                done: true,
                content: next.value,
                status: "success",
              },
              msg.messageId,
            );
          } else {
            this.send(
              msg.messageType,
              {
                done: true,
                content: response,
                status: "success",
              },
              msg.messageId,
            );
          }
        } catch (e: any) {
          this.send(
            msg.messageType,
            { done: true, error: e.message, status: "error" },
            msg.messageId,
          );

          console.warn(`Error running handler for "${msg.messageType}": `, e);
          this._onErrorHandlers.forEach((handler) => {
            handler(msg, e);
          });
        }
      });

      // Call handler which is waiting for the response, nothing to return
      this.idListeners.get(msg.messageId)?.(msg);
    } catch (e) {
      let truncatedLine = line;
      if (line.length > 200) {
        truncatedLine =
          line.substring(0, 100) + "..." + line.substring(line.length - 100);
      }
      console.error("Error parsing line: ", truncatedLine, e);
      return;
    }
  }

  private _unfinishedLine: string | undefined = undefined;

  private _handleData(data: Buffer) {
    const d = data.toString();
    const lines = d.split(/\r\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) {
      return;
    }

    if (this._unfinishedLine) {
      lines[0] = this._unfinishedLine + lines[0];
      this._unfinishedLine = undefined;
    }
    if (!d.endsWith("\r\n")) {
      this._unfinishedLine = lines.pop();
    }
    lines.forEach((line) => this._handleLine(line));
  }

  send<T extends keyof FromProtocol>(
    messageType: T,
    data: FromProtocol[T][0],
    messageId?: string,
  ): string {
    messageId = messageId ?? uuidv4();
    const msg: Message = {
      messageType: messageType as string,
      data,
      messageId,
    };

    this.socket?.write(JSON.stringify(msg) + "\r\n");
    return messageId;
  }

  on<T extends keyof ToProtocol>(
    messageType: T,
    handler: (message: Message<ToProtocol[T][0]>) => ToProtocol[T][1],
  ): void {
    if (!this.typeListeners.has(messageType)) {
      this.typeListeners.set(messageType, []);
    }
    this.typeListeners.get(messageType)?.push(handler);
  }

  invoke<T extends keyof ToProtocol>(
    messageType: T,
    data: ToProtocol[T][0],
  ): ToProtocol[T][1] {
    return this.typeListeners.get(messageType)?.[0]?.({
      messageId: uuidv4(),
      messageType: messageType as string,
      data,
    });
  }

  request<T extends keyof FromProtocol>(
    messageType: T,
    data: FromProtocol[T][0],
  ): Promise<FromProtocol[T][1]> {
    const messageId = uuidv4();
    return new Promise((resolve) => {
      const handler = (msg: Message) => {
        resolve(msg.data);
        this.idListeners.delete(messageId);
      };
      this.idListeners.set(messageId, handler);
      this.send(messageType, data, messageId);
    });
  }
}
