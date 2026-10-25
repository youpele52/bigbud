import path from "node:path";
import { TextDecoder } from "node:util";
import { isWslDistributionName } from "@bigbud/shared/terminalExecutionTarget";
import {
  runProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "../../utils/processRunner";

export const WSL_PROBE_TIMEOUT_MS = 10_000;
export const WSL_OUTPUT_LIMIT_BYTES = 8192;

export type WslProcessRunner = (
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessRunResult>;

/** Use a Windows executable directly, never cmd.exe or an ambient default distro. */
export function wslExecutable(): string {
  return path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");
}

export const runWslProcess: WslProcessRunner = (args, options = {}) =>
  runProcess(wslExecutable(), args, {
    ...options,
    shell: false,
    settleOnTimeout: true,
    encoding: "latin1",
    allowNonZeroExit: true,
    maxBufferBytes: WSL_OUTPUT_LIMIT_BYTES,
    timeoutMs: options.timeoutMs ?? WSL_PROBE_TIMEOUT_MS,
  }).catch((error: unknown) => {
    // ProcessRunner diagnostics include argv; do not expose environment values or guest stderr.
    const reason = error instanceof Error ? error.message : "";
    if (reason.includes("timed out")) throw new Error("WSL process execution timed out.");
    if (reason.includes("cancelled")) throw new Error("WSL process execution was cancelled.");
    if (reason.includes("buffer limit"))
      throw new Error("WSL process output exceeded the buffer limit.");
    throw new Error(
      "WSL process could not complete. Check WSL installation and the selected target.",
    );
  });

/** WSL listing may be UTF-16LE; guest-command output is UTF-8. Preserve bytes first. */
export function decodeWslOutput(raw: string, allowUtf16 = true): string {
  const bytes = Buffer.from(raw, "latin1");
  const utf16 = allowUtf16 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || bytes.includes(0));
  if (utf16 && bytes.length % 2 !== 0) throw new Error("Malformed WSL output encoding.");
  return new TextDecoder(utf16 ? "utf-16le" : "utf-8", { fatal: true }).decode(bytes);
}

export function parseWslDistributions(raw: string): string[] {
  const lines = decodeWslOutput(raw)
    .split(/\r?\n/)
    .filter((line) => line !== "");
  if (
    lines.length > 128 ||
    lines.some((line) => !isWslDistributionName(line)) ||
    new Set(lines).size !== lines.length
  )
    throw new Error("The WSL distribution list is malformed.");
  return lines;
}

export async function listWslDistributions(
  runner: WslProcessRunner = runWslProcess,
  platform: NodeJS.Platform = process.platform,
  options: ProcessRunOptions = {},
): Promise<{ supported: boolean; distributions: string[] }> {
  if (platform !== "win32") return { supported: false, distributions: [] };
  const result = await runner(["--list", "--quiet"], options);
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated || result.stderrTruncated)
    throw new Error("WSL distribution discovery failed. Check WSL installation and retry.");
  return { supported: true, distributions: parseWslDistributions(result.stdout) };
}
