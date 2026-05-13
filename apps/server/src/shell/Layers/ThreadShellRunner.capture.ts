const METADATA_SEPARATOR = "\u001f";
const ANSI_ESCAPE_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;]*[ -/]*[@-~]|\x1b\].*?(?:\x07|\x1b\\)|[\u0090\u009d\u009e\u009f].*?(?:\u0007|\u001b\\)/g;

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_TTL_MS = 10 * 60_000;
export const MAX_UNFLUSHED_OUTPUT_BYTES = 256 * 1024;
export const MAX_RETURNED_OUTPUT_BYTES = 512 * 1024;

export function normalizeVisibleText(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, "").replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function quoteForShellEval(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildReadyMarker(): string {
  return `__BIGBUD_SHELL_READY__${crypto.randomUUID()}__`;
}

export function buildCommandStartMarker(commandId: string): string {
  return `__BIGBUD_SHELL_START__${commandId}__`;
}

export function buildCommandEndMarker(commandId: string): string {
  return `__BIGBUD_SHELL_END__${commandId}__`;
}

export function buildReadyScript(marker: string): string {
  return [
    "PROMPT='' RPROMPT='' PS1='' PROMPT2='' RPS1=''",
    "unsetopt PROMPT_SP 2>/dev/null || true",
    "stty -echo",
    `printf '%s\\n' '${marker}'`,
  ].join("; ");
}

export function buildCommandScript(command: string, commandId: string): string {
  const startMarker = buildCommandStartMarker(commandId);
  const endMarker = buildCommandEndMarker(commandId);
  const escapedCommand = quoteForShellEval(command);
  return [
    `printf '%s\\n' '${startMarker}'`,
    `eval -- ${escapedCommand}`,
    "__bigbud_shell_exit=$?",
    "__bigbud_shell_pwd=$PWD",
    `printf '\\n%s\\037%s\\037%s\\n' '${endMarker}' "$__bigbud_shell_exit" "$__bigbud_shell_pwd"`,
  ].join("; ");
}

export function parseCommandCompletion(
  endLine: string,
  expectedEndMarker: string,
): { readonly exitCode: number | null; readonly cwd: string | null } {
  const parts = endLine.split(METADATA_SEPARATOR);
  if (parts[0] !== expectedEndMarker) {
    throw new Error("Hidden shell command completed with an invalid marker.");
  }

  const exitCodeRaw = parts[1]?.trim() ?? "";
  const cwdRaw = parts.slice(2).join(METADATA_SEPARATOR).trim();
  const parsedExitCode = Number.parseInt(exitCodeRaw, 10);

  return {
    exitCode: Number.isInteger(parsedExitCode) ? parsedExitCode : null,
    cwd: cwdRaw.length > 0 ? cwdRaw : null,
  };
}

export function trimLeadingCommandNewline(value: string): string {
  if (value.startsWith("\n")) {
    return value.slice(1);
  }
  return value;
}

export function findLineMarker(buffer: string, marker: string, suffix: string): number {
  const directPrefix = `${marker}${suffix}`;
  if (buffer.startsWith(directPrefix)) {
    return 0;
  }

  const linePrefix = `\n${marker}${suffix}`;
  const index = buffer.indexOf(linePrefix);
  return index === -1 ? -1 : index + 1;
}

export function findFlushBoundary(buffer: string): number {
  const lastNewline = buffer.lastIndexOf("\n");
  return lastNewline === -1 ? 0 : lastNewline + 1;
}

export function trimOutputTailToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) {
    return value;
  }

  const buffer = Buffer.from(value, "utf-8");
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length) {
    const byte = buffer[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    start += 1;
  }
  return buffer.subarray(start).toString("utf-8");
}

export { METADATA_SEPARATOR };
