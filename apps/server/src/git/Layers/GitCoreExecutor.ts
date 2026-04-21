/**
 * GitCoreExecutor - Raw git process spawning, output collection, and Trace2 monitoring.
 *
 * @module GitCoreExecutor
 */
import {
  Data,
  Effect,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError } from "@bigbud/contracts";
import { compactTraceAttributes } from "../../observability/Attributes.ts";
import {
  type ExecuteGitInput,
  type ExecuteGitProgress,
  type ExecuteGitResult,
} from "../Services/GitCore.ts";
import { decodeJsonResult } from "@bigbud/shared/schemaJson";
import { quoteGitCommand, toGitCommandError } from "./GitCoreUtils.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
export const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

type TraceTailState = {
  processedChars: number;
  remainder: string;
};

class StatusRemoteRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  remoteName: string;
}> {}

export { StatusRemoteRefreshCacheKey };

const nowUnixNano = (): bigint => BigInt(Date.now()) * 1_000_000n;

const addCurrentSpanEvent = (name: string, attributes: Record<string, unknown>) =>
  Effect.currentSpan.pipe(
    Effect.tap((span) =>
      Effect.sync(() => {
        span.event(name, nowUnixNano(), compactTraceAttributes(attributes));
      }),
    ),
    Effect.catch(() => Effect.void),
  );

function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

export const createTrace2Monitor = Effect.fn("createTrace2Monitor")(function* (
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: ExecuteGitProgress | undefined,
): Effect.fn.Return<
  Trace2Monitor,
  PlatformError.PlatformError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const traceFilePath = yield* fs.makeTempFileScoped({
    prefix: `t3code-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  const traceTailState = yield* Ref.make<TraceTailState>({
    processedChars: 0,
    remainder: "",
  });

  const handleTraceLine = Effect.fn("handleTraceLine")(function* (line: string) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }

    const traceRecord = decodeJsonResult(Trace2Record)(trimmedLine);
    if (Result.isFailure(traceRecord)) {
      yield* Effect.logDebug(
        `GitCore.trace2: failed to parse trace line for ${quoteGitCommand(input.args)} in ${input.cwd}`,
        traceRecord.failure,
      );
      return;
    }

    if (traceRecord.success.child_class !== "hook") {
      return;
    }

    const event = traceRecord.success.event;
    const childKey = trace2ChildKey(traceRecord.success);
    if (childKey === null) {
      return;
    }
    const started = hookStartByChildKey.get(childKey);
    const hookNameFromEvent =
      typeof traceRecord.success.hook_name === "string" ? traceRecord.success.hook_name.trim() : "";
    const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
    if (hookName.length === 0) {
      return;
    }

    if (event === "child_start") {
      hookStartByChildKey.set(childKey, { hookName, startedAtMs: Date.now() });
      yield* addCurrentSpanEvent("git.hook.started", {
        hookName,
      });
      if (progress.onHookStarted) {
        yield* progress.onHookStarted(hookName);
      }
      return;
    }

    if (event === "child_exit") {
      hookStartByChildKey.delete(childKey);
      const code = traceRecord.success.code;
      const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
      const durationMs = started ? Math.max(0, Date.now() - started.startedAtMs) : null;
      yield* addCurrentSpanEvent("git.hook.finished", {
        hookName: started?.hookName ?? hookName,
        exitCode,
        durationMs,
      });
      if (progress.onHookFinished) {
        yield* progress.onHookFinished({
          hookName: started?.hookName ?? hookName,
          exitCode,
          durationMs,
        });
      }
    }
  });

  const deltaMutex = yield* Semaphore.make(1);
  const readTraceDelta = deltaMutex.withPermit(
    fs.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          Ref.modify(traceTailState, ({ processedChars, remainder }) => {
            if (contents.length <= processedChars) {
              return [[], { processedChars, remainder }];
            }

            const appended = contents.slice(processedChars);
            const combined = remainder + appended;
            const lines = combined.split("\n");
            const nextRemainder = lines.pop() ?? "";

            return [
              lines.map((line) => line.replace(/\r$/, "")),
              {
                processedChars: contents.length,
                remainder: nextRemainder,
              },
            ];
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, handleTraceLine, { discard: true })),
          ),
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fs.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    const isTargetTraceEvent =
      eventPath === traceFilePath ||
      eventPath === traceFileName ||
      path.basename(eventPath) === traceFileName;
    if (!isTargetTraceEvent) return Effect.void;
    return readTraceDelta;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  const finalizeTrace2Monitor = Effect.fn("finalizeTrace2Monitor")(function* () {
    yield* readTraceDelta;
    const finalLine = yield* Ref.modify(traceTailState, ({ processedChars, remainder }) => [
      remainder.trim(),
      {
        processedChars,
        remainder: "",
      },
    ]);
    if (finalLine.length > 0) {
      yield* handleTraceLine(finalLine);
    }
  });

  yield* Effect.addFinalizer(finalizeTrace2Monitor);

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: readTraceDelta,
  };
});

export const collectOutput = Effect.fn("collectOutput")(function* <E>(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
  truncateOutputAtMaxBytes: boolean,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let lineBuffer = "";
  let truncated = false;

  const emitCompleteLines = Effect.fn("emitCompleteLines")(function* (flush: boolean) {
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0 && onLine) {
        yield* onLine(line);
      }
      newlineIndex = lineBuffer.indexOf("\n");
    }

    if (flush) {
      const trailing = lineBuffer.replace(/\r$/, "");
      lineBuffer = "";
      if (trailing.length > 0 && onLine) {
        yield* onLine(trailing);
      }
    }
  });

  const processChunk = Effect.fn("processChunk")(function* (chunk: Uint8Array) {
    if (truncateOutputAtMaxBytes && truncated) {
      return;
    }
    const nextBytes = bytes + chunk.byteLength;
    if (!truncateOutputAtMaxBytes && nextBytes > maxOutputBytes) {
      return yield* new GitCommandError({
        operation: input.operation,
        command: quoteGitCommand(input.args),
        cwd: input.cwd,
        detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
      });
    }

    const chunkToDecode =
      truncateOutputAtMaxBytes && nextBytes > maxOutputBytes
        ? chunk.subarray(0, Math.max(0, maxOutputBytes - bytes))
        : chunk;
    bytes += chunkToDecode.byteLength;
    truncated = truncateOutputAtMaxBytes && nextBytes > maxOutputBytes;

    const decoded = decoder.decode(chunkToDecode, { stream: !truncated });
    text += decoded;
    lineBuffer += decoded;
    yield* emitCompleteLines(false);
  });

  yield* Stream.runForEach(stream, processChunk).pipe(
    Effect.mapError(toGitCommandError(input, "output stream failed.")),
  );

  const remainder = truncated ? "" : decoder.decode();
  text += remainder;
  lineBuffer += remainder;
  yield* emitCompleteLines(true);
  return {
    text,
    truncated,
  };
});

/**
 * Build the raw `execute` function backed by a real child process spawner.
 * Yields FileSystem, Path and ChildProcessSpawner from context, then returns
 * a ready-to-use execute function with all services closed over.
 */
export const makeRawExecute = Effect.fn("makeRawExecute")(function* (): Effect.fn.Return<
  (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return Effect.fnUntraced(function* (
    input: ExecuteGitInput,
  ): Effect.fn.Return<ExecuteGitResult, GitCommandError, never> {
    const commandInput = {
      ...input,
      args: [...input.args],
    } as const;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const truncateOutputAtMaxBytes = input.truncateOutputAtMaxBytes ?? false;

    const runGitCommand = Effect.fn("runGitCommand")(function* (): Effect.fn.Return<
      ExecuteGitResult,
      GitCommandError,
      Scope.Scope | FileSystem.FileSystem | Path.Path
    > {
      const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
        Effect.provideService(Path.Path, path),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.mapError(toGitCommandError(commandInput, "failed to create trace2 monitor.")),
      );
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make("git", commandInput.args, {
            cwd: commandInput.cwd,
            env: {
              ...process.env,
              ...input.env,
              ...trace2Monitor.env,
            },
          }),
        )
        .pipe(Effect.mapError(toGitCommandError(commandInput, "failed to spawn.")));

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectOutput(
            commandInput,
            child.stdout,
            maxOutputBytes,
            truncateOutputAtMaxBytes,
            input.progress?.onStdoutLine,
          ),
          collectOutput(
            commandInput,
            child.stderr,
            maxOutputBytes,
            truncateOutputAtMaxBytes,
            input.progress?.onStderrLine,
          ),
          child.exitCode.pipe(
            Effect.map((value) => Number(value)),
            Effect.mapError(toGitCommandError(commandInput, "failed to report exit code.")),
          ),
          input.stdin === undefined
            ? Effect.void
            : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                Effect.mapError(toGitCommandError(commandInput, "failed to write stdin.")),
              ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(([out, err, code]) => [out, err, code] as const));
      yield* trace2Monitor.flush;

      const stdoutText = stdout.text;
      const stderrText = stderr.text;

      if (!input.allowNonZeroExit && exitCode !== 0) {
        const trimmedStderr = stderrText.trim();
        return yield* new GitCommandError({
          operation: commandInput.operation,
          command: quoteGitCommand(commandInput.args),
          cwd: commandInput.cwd,
          detail:
            trimmedStderr.length > 0
              ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
              : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
        });
      }

      return {
        code: exitCode,
        stdout: stdoutText,
        stderr: stderrText,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      } satisfies ExecuteGitResult;
    });

    return yield* runGitCommand().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.scoped,
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () =>
            Effect.fail(
              new GitCommandError({
                operation: commandInput.operation,
                command: quoteGitCommand(commandInput.args),
                cwd: commandInput.cwd,
                detail: `${quoteGitCommand(commandInput.args)} timed out.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Re-exports from helpers module
// ---------------------------------------------------------------------------

export type { ExecuteGitOptions, GitHelpers } from "./GitCoreExecutor.helpers.ts";
export { wrapExecuteWithMetrics, makeGitHelpers } from "./GitCoreExecutor.helpers.ts";
