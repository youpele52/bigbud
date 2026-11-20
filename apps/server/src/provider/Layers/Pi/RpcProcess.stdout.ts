/**
 * Newline framing for Pi's RPC stdout, bounded per record (F-B5).
 *
 * Decodes UTF-8 across chunk boundaries and hands each complete line to `onLine`. A record
 * longer than {@link PROVIDER_STDIO_MAX_LINE_BYTES} without a newline calls `onOverflow` once
 * with {@link ProviderStdioLineTooLongError} and drops everything after it, so the partial-line
 * buffer can never grow past the limit.
 *
 * @module RpcProcess.stdout
 */
import { StringDecoder } from "node:string_decoder";

import {
  PROVIDER_STDIO_MAX_LINE_BYTES,
  ProviderStdioLineTooLongError,
  createLineLengthGuard,
} from "../../providerStdioLineLimit.ts";

export function createPiStdoutReader(input: {
  readonly onLine: (line: string) => void;
  readonly onOverflow: (error: ProviderStdioLineTooLongError) => void;
  readonly maxLineBytes?: number;
}) {
  const maxLineBytes = input.maxLineBytes ?? PROVIDER_STDIO_MAX_LINE_BYTES;
  const decoder = new StringDecoder("utf8");
  const guard = createLineLengthGuard(maxLineBytes);
  let buffer = "";
  let overflowed = false;

  const push = (chunk: Buffer | string) => {
    if (overflowed) return;
    if (guard.observe(chunk)) {
      overflowed = true;
      buffer = "";
      input.onOverflow(new ProviderStdioLineTooLongError("Pi RPC", maxLineBytes));
      return;
    }
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    for (
      let newline = buffer.indexOf("\n");
      newline !== -1;
      newline = buffer.indexOf("\n", start)
    ) {
      const line = buffer.slice(start, newline);
      start = newline + 1;
      input.onLine(line);
    }
    if (start > 0) buffer = buffer.slice(start);
  };

  const flush = () => {
    if (overflowed) return;
    buffer += decoder.end();
    if (buffer.length > 0) {
      const rest = buffer;
      buffer = "";
      input.onLine(rest);
    }
  };

  return { push, flush };
}
