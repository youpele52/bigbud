import type { RunSshCommandInput } from "../ssh/sshProcess.ts";

/** Retained remote stderr per failed setup command (phases 1–6 implementation contract). */
export const REMOTE_AGENT_STDERR_TAIL_BYTES = 8 * 1024;
/** Captured before tailing so a noisy prefix cannot evict the final failure line. */
const REMOTE_AGENT_CAPTURE_BYTES = 64 * 1024;

export type RemoteAgentCommandStage = "platform" | "preflight" | "install" | "check" | "control";

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g,
  /\b(authorization|bearer|token|secret|password|passwd|api[_-]?key)\b(\s*[:=]\s*|\s+)\S+/gi,
  /\b[A-Za-z0-9+_-]{48,}={0,2}/g,
];

/**
 * Bound, redact and strip terminal controls from remote stderr while keeping the tail, which
 * normally holds the decisive failure. Newlines and tabs survive for multi-line diagnostics.
 */
export function sanitizeRemoteAgentStderr(
  stderr: string,
  maxBytes: number = REMOTE_AGENT_STDERR_TAIL_BYTES,
): string {
  let text = stderr
    // Drop ANSI CSI/OSC sequences before stripping the remaining controls.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, label?: string, separator?: string) =>
      typeof label === "string" && typeof separator === "string"
        ? `${label}${separator}[redacted]`
        : "[redacted]",
    );
  }
  const encoded = Buffer.from(text.trim(), "utf8");
  if (encoded.length <= maxBytes) return text.trim();
  // Decoding a mid-sequence slice yields U+FFFD at the start; drop it with the partial line.
  const tail = encoded.subarray(encoded.length - maxBytes).toString("utf8");
  const newline = tail.indexOf("\n");
  return (newline >= 0 && newline < tail.length - 1 ? tail.slice(newline + 1) : tail).trim();
}

const STAGE_LABEL: Record<RemoteAgentCommandStage, string> = {
  control: "control command",
  platform: "platform probe",
  preflight: "pre-flight check",
  install: "agent upload",
  check: "agent check",
};

/** A remote setup command failed; the message never contains the script, stdin or credentials. */
export class RemoteAgentRemoteCommandError extends Error {
  readonly _tag = "RemoteAgentRemoteCommandError";

  constructor(
    readonly stage: RemoteAgentCommandStage,
    readonly exitCode: number | null,
    readonly timedOut: boolean,
    readonly stderrTail: string,
  ) {
    super(
      timedOut
        ? `The remote ${STAGE_LABEL[stage]} timed out.`
        : `The remote ${STAGE_LABEL[stage]} failed${exitCode === null ? "" : ` (exit ${exitCode})`}.`,
    );
    this.name = "RemoteAgentRemoteCommandError";
  }
}

export function findRemoteAgentRemoteCommandError(
  cause: unknown,
): RemoteAgentRemoteCommandError | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof RemoteAgentRemoteCommandError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

interface RemoteCommandOutcome {
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly code?: unknown;
  readonly timedOut?: unknown;
  readonly signal?: unknown;
  readonly stdoutTruncated?: unknown;
}

/**
 * Run a remote setup command so a failure keeps its stderr tail instead of being reduced to
 * "SSH command failed". Results without exit metadata (test doubles) are treated as success.
 */
export async function runRemoteAgentDiagnosedCommand(
  run: (input: RunSshCommandInput) => Promise<unknown>,
  stage: RemoteAgentCommandStage,
  input: RunSshCommandInput,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = (await run({
    ...input,
    allowNonZeroExit: true,
    outputMode: "truncate",
    stderrTailBytes: REMOTE_AGENT_CAPTURE_BYTES,
    maxBufferBytes: Math.max(input.maxBufferBytes ?? 0, REMOTE_AGENT_CAPTURE_BYTES),
  })) as RemoteCommandOutcome | null | undefined;
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  const code = typeof result?.code === "number" ? result.code : null;
  const timedOut = result?.timedOut === true;
  const signaled = typeof result?.signal === "string" && result.signal.length > 0;
  if (timedOut || signaled || (code !== null && code !== 0)) {
    throw new RemoteAgentRemoteCommandError(
      stage,
      code,
      timedOut,
      sanitizeRemoteAgentStderr(stderr),
    );
  }
  if (
    result?.stdoutTruncated === true ||
    (input.maxBufferBytes !== undefined && Buffer.byteLength(stdout) > input.maxBufferBytes)
  ) {
    // The caller's bound still applies to stdout; an oversized reply cannot be parsed safely.
    throw new RemoteAgentRemoteCommandError(stage, code, false, "Remote output exceeded limit.");
  }
  return { stdout, stderr };
}
