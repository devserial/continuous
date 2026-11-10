import { once } from "node:events";
import net from "node:net";

import { CoreBinaryTcpMessenger } from "../src/IpcMessenger";
import {
  DEV_TCP_HOST,
  DEV_TCP_TOKEN_ENV,
  TcpMessenger,
  devTcpAuthLine,
  devTcpAuthLineMatches,
  resolveDevTcpToken,
} from "../src/TcpMessenger";

const TOKEN = "0123456789abcdef0123";

function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
  });
}

function readLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (data: Buffer) => {
      buf += data.toString("utf8");
      const idx = buf.indexOf("\r\n");
      if (idx === -1) return;
      socket.off("data", onData);
      resolve(buf.slice(0, idx));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function connect(port: number): Promise<net.Socket> {
  const socket = net.connect(port, DEV_TCP_HOST);
  await once(socket, "connect");
  return socket;
}

describe("dev TCP control port", () => {
  const open: TcpMessenger<any, any>[] = [];

  afterEach(async () => {
    while (open.length > 0) {
      await open.pop()?.close();
    }
  });

  function start(token = TOKEN, port = 0): TcpMessenger<any, any> {
    const messenger = new TcpMessenger({ port, token });
    open.push(messenger);
    return messenger;
  }

  it("generates a token when none is configured and refuses a short one", () => {
    const previous = process.env[DEV_TCP_TOKEN_ENV];
    delete process.env[DEV_TCP_TOKEN_ENV];
    try {
      const resolved = resolveDevTcpToken(undefined);
      expect(resolved.generated).toBe(true);
      expect(resolved.token.length).toBeGreaterThanOrEqual(16);
      const line = devTcpAuthLine(resolved.token).replace(/\r\n$/, "");
      expect(devTcpAuthLineMatches(line, resolved.token)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env[DEV_TCP_TOKEN_ENV];
      else process.env[DEV_TCP_TOKEN_ENV] = previous;
    }

    expect(resolveDevTcpToken(`  ${TOKEN}  `)).toEqual({
      token: TOKEN,
      generated: false,
    });
    expect(() => resolveDevTcpToken("short")).toThrow(/16/);
    expect(() => new TcpMessenger({ port: 0, token: "short" })).toThrow(/16/);
  });

  it("rejects an auth line that is not the token", () => {
    expect(devTcpAuthLineMatches("not-json", TOKEN)).toBe(false);
    expect(
      devTcpAuthLineMatches(
        JSON.stringify({ messageType: "ping", messageId: "1", data: TOKEN }),
        TOKEN,
      ),
    ).toBe(false);
    expect(
      devTcpAuthLineMatches(
        devTcpAuthLine("0123456789abcdefxxxx").replace(/\r\n$/, ""),
        TOKEN,
      ),
    ).toBe(false);
    expect(
      devTcpAuthLineMatches(devTcpAuthLine(TOKEN).replace(/\r\n$/, ""), TOKEN),
    ).toBe(true);
  });

  it("binds to loopback and ignores a client that does not present the token", async () => {
    const messenger = start();
    await messenger.ready;
    const addr = messenger.address();
    expect(addr?.address).toBe(DEV_TCP_HOST);
    expect(addr?.address).not.toBe("0.0.0.0");

    let handled = 0;
    messenger.on("ping" as any, () => {
      handled += 1;
      return "pong";
    });

    const bad = await connect(addr!.port);
    const badClosed = closed(bad);
    bad.write(
      JSON.stringify({ messageType: "ping", messageId: "1", data: "ping" }) +
        "\r\n",
    );
    await badClosed;
    expect(handled).toBe(0);

    const wrong = await connect(addr!.port);
    const wrongClosed = closed(wrong);
    wrong.write(devTcpAuthLine("0123456789abcdefxxxx"));
    await wrongClosed;
    expect(handled).toBe(0);
  });

  it("accepts a token split across packets and keeps serving that client", async () => {
    const messenger = start();
    await messenger.ready;
    const port = messenger.address()!.port;
    let handled = 0;
    messenger.on("ping" as any, () => {
      handled += 1;
      return "pong";
    });

    const good = await connect(port);
    const line = devTcpAuthLine(TOKEN);
    good.write(line.slice(0, 8));
    good.write(line.slice(8));
    const pending = readLine(good);
    good.write(
      JSON.stringify({ messageType: "ping", messageId: "2", data: "ping" }) +
        "\r\n",
    );
    expect(JSON.parse(await pending).data.content).toBe("pong");

    const late = await connect(port);
    const lateClosed = closed(late);
    late.write(
      JSON.stringify({ messageType: "ping", messageId: "3", data: "ping" }) +
        "\r\n",
    );
    await lateClosed;
    expect(handled).toBe(1);

    const again = readLine(good);
    good.write(
      JSON.stringify({ messageType: "ping", messageId: "4", data: "ping" }) +
        "\r\n",
    );
    expect(JSON.parse(await again).data.content).toBe("pong");
    expect(handled).toBe(2);
    good.end();
  });

  it("accepts the dev client once it sends the token", async () => {
    const messenger = start();
    await messenger.ready;
    const port = messenger.address()!.port;
    messenger.on("ping" as any, () => "pong");

    const client = new CoreBinaryTcpMessenger<any, any>({ port, token: TOKEN });
    try {
      const response = await client.request("ping" as any, "ping");
      expect(response).toEqual({
        done: true,
        content: "pong",
        status: "success",
      });
    } finally {
      client.close();
    }
  });
});
