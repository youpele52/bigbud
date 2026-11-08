import { Data, Effect } from "effect";
import { runProcess } from "../../utils/processRunner";

export class TerminalSubprocessCheckError extends Data.TaggedError("TerminalSubprocessCheckError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly terminalPid: number;
  readonly command: "powershell" | "pgrep" | "ps";
}> {}

export type TerminalSubprocessChecker = (
  terminalPid: number,
) => Effect.Effect<boolean, TerminalSubprocessCheckError>;

function checkWindowsSubprocessActivity(
  terminalPid: number,
): Effect.Effect<boolean, TerminalSubprocessCheckError> {
  const command = [
    `try { $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" -ErrorAction Stop } catch { exit 2 }`,
    "if ($children) { exit 0 }",
    "exit 1",
  ].join("; ");
  return Effect.tryPromise({
    try: () =>
      runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new TerminalSubprocessCheckError({
        message: "Failed to check Windows terminal subprocess activity.",
        cause,
        terminalPid,
        command: "powershell",
      }),
  }).pipe(
    Effect.flatMap((result) =>
      !result.timedOut && (result.code === 0 || result.code === 1)
        ? Effect.succeed(result.code === 0)
        : Effect.fail(
            new TerminalSubprocessCheckError({
              message: "Windows terminal subprocess inspection failed.",
              terminalPid,
              command: "powershell",
            }),
          ),
    ),
  );
}

const checkPosixSubprocessActivity = Effect.fn("terminal.checkPosixSubprocessActivity")(function* (
  terminalPid: number,
): Effect.fn.Return<boolean, TerminalSubprocessCheckError> {
  const runPgrep = Effect.tryPromise({
    try: () =>
      runProcess("pgrep", ["-P", String(terminalPid)], {
        timeoutMs: 1_000,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new TerminalSubprocessCheckError({
        message: "Failed to inspect terminal subprocesses with pgrep.",
        cause,
        terminalPid,
        command: "pgrep",
      }),
  });

  const runPs = Effect.tryPromise({
    try: () =>
      runProcess("ps", ["-eo", "pid=,ppid="], {
        timeoutMs: 1_000,
        allowNonZeroExit: true,
        maxBufferBytes: 262_144,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new TerminalSubprocessCheckError({
        message: "Failed to inspect terminal subprocesses with ps.",
        cause,
        terminalPid,
        command: "ps",
      }),
  });

  const pgrepResult = yield* Effect.exit(runPgrep);
  if (pgrepResult._tag === "Success" && !pgrepResult.value.timedOut) {
    if (pgrepResult.value.code === 0) {
      return pgrepResult.value.stdout.trim().length > 0;
    }
    if (pgrepResult.value.code === 1) {
      return false;
    }
  }

  const psResult = yield* Effect.exit(runPs);
  if (
    psResult._tag === "Failure" ||
    psResult.value.code !== 0 ||
    psResult.value.timedOut ||
    psResult.value.stdoutTruncated
  ) {
    return yield* new TerminalSubprocessCheckError({
      message: "Terminal subprocess inspection failed with both pgrep and ps.",
      terminalPid,
      command: "ps",
      cause: psResult,
    });
  }

  for (const line of psResult.value.stdout.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (ppid === terminalPid) {
      return true;
    }
  }
  return false;
});

export const defaultSubprocessChecker = Effect.fn("terminal.defaultSubprocessChecker")(function* (
  terminalPid: number,
): Effect.fn.Return<boolean, TerminalSubprocessCheckError> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return false;
  }
  if (process.platform === "win32") {
    return yield* checkWindowsSubprocessActivity(terminalPid);
  }
  return yield* checkPosixSubprocessActivity(terminalPid);
});
