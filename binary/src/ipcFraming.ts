/**
 * Core IPC frames are UTF-8 JSON records separated by CRLF.
 * Pipe and socket chunks may split a code point or the CRLF itself, so bytes
 * stay buffered until a whole frame is present and only then are decoded.
 */
export interface IpcFrameBuffer {
  pending: Buffer;
}

export function createIpcFrameBuffer(): IpcFrameBuffer {
  return { pending: Buffer.alloc(0) };
}

export function pushIpcChunk(state: IpcFrameBuffer, chunk: Buffer): string[] {
  state.pending =
    state.pending.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([state.pending, chunk]);

  const lines: string[] = [];
  const buf = state.pending;
  let start = 0;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
      const line = buf.subarray(start, i).toString("utf8");
      if (line.trim() !== "") {
        lines.push(line);
      }
      start = i + 2;
      i++;
    }
  }

  state.pending = start === 0 ? buf : Buffer.from(buf.subarray(start));
  return lines;
}
