/**
 * Maximum length of one newline-delimited record on a provider's stdout (F-B5).
 *
 * Pi's RPC reader and Codex's `readline` interface buffer a partial line until its newline
 * arrives. A provider that writes without newlines (a bug, a corrupted stream, or a binary
 * dump) used to grow that buffer without limit. {@link createLineLengthGuard} tracks how many
 * bytes have arrived since the last newline; once a record exceeds
 * {@link PROVIDER_STDIO_MAX_LINE_BYTES} the caller ends the session with
 * {@link ProviderStdioLineTooLongError}, a visible protocol error, instead of buffering further.
 *
 * The limit is far above any legitimate record (large tool outputs and inline images included),
 * so it only trips on a broken stream.
 *
 * @module providerStdioLineLimit
 */

/** Longest stdout record a provider may send before the session fails with a protocol error. */
export const PROVIDER_STDIO_MAX_LINE_BYTES = 64 * 1024 * 1024;

export class ProviderStdioLineTooLongError extends Error {
  readonly _tag = "ProviderStdioLineTooLongError";

  constructor(
    readonly provider: string,
    readonly maxBytes: number,
  ) {
    super(
      `${provider} protocol error: a stdout record exceeded ${maxBytes} bytes without a newline; the session was stopped.`,
    );
    this.name = "ProviderStdioLineTooLongError";
  }
}

const NEWLINE = 0x0a;

/**
 * Observes raw stdout chunks. `observe` returns true once the current (unterminated) record is
 * longer than `maxBytes`. String chunks count UTF-16 code units, which never exceed their bytes.
 */
export function createLineLengthGuard(maxBytes: number = PROVIDER_STDIO_MAX_LINE_BYTES) {
  let pending = 0;
  return {
    observe(chunk: Buffer | string): boolean {
      const newline =
        typeof chunk === "string" ? chunk.lastIndexOf("\n") : chunk.lastIndexOf(NEWLINE);
      pending = newline === -1 ? pending + chunk.length : chunk.length - newline - 1;
      return pending > maxBytes;
    },
  };
}
