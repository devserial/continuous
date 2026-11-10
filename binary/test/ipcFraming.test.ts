import { createIpcFrameBuffer, pushIpcChunk } from "../src/ipcFraming";

function frames(chunks: Buffer[]): string[] {
  const state = createIpcFrameBuffer();
  return chunks.flatMap((chunk) => pushIpcChunk(state, chunk));
}

describe("ipc framing", () => {
  it("decodes a code point that is split across chunks", () => {
    const message = Buffer.from('{"text":"héllo 世界"}\r\n', "utf8");
    for (let split = 1; split < message.length; split++) {
      const lines = frames([
        message.subarray(0, split),
        message.subarray(split),
      ]);
      expect(lines).toEqual(['{"text":"héllo 世界"}']);
    }
  });

  it("does not drop or glue messages when CRLF is its own chunk", () => {
    const lines = frames([
      Buffer.from('{"a":1}', "utf8"),
      Buffer.from("\r\n", "utf8"),
      Buffer.from('{"b":2}\r', "utf8"),
      Buffer.from("\n", "utf8"),
    ]);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("keeps an unfinished frame until CRLF arrives", () => {
    const state = createIpcFrameBuffer();
    expect(pushIpcChunk(state, Buffer.from('{"a":1}\r', "utf8"))).toEqual([]);
    expect(pushIpcChunk(state, Buffer.from('\n{"b":', "utf8"))).toEqual([
      '{"a":1}',
    ]);
    expect(pushIpcChunk(state, Buffer.from("2}\r\n", "utf8"))).toEqual([
      '{"b":2}',
    ]);
  });
});
