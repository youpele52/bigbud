/**
 * Higher-level git helpers and metrics wrapping built on top of the raw execute function.
 *
 * @module GitCoreExecutor.helpers
 */
import { Effect } from "effect";

import { GitCommandError } from "@bigbud/contracts";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../../observability/Metrics.ts";
import {
  type ExecuteGitInput,
  type ExecuteGitProgress,
  type ExecuteGitResult,
} from "../Services/GitCore.ts";

const commandLabel = (args: readonly string[]) => `git ${args.join(" ")}`;

// ---------------------------------------------------------------------------
// ExecuteGitOptions — options for the high-level executeGit helper
// ---------------------------------------------------------------------------

export interface ExecuteGitOptions {
  stdin?: string | undefined;
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
  maxOutputBytes?: number | undefined;
  truncateOutputAtMaxBytes?: boolean | undefined;
  progress?: ExecuteGitProgress | undefined;
}

// ---------------------------------------------------------------------------
// Metrics wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a raw execute function with metrics and tracing.
 */
export function wrapExecuteWithMetrics(
  executeRaw: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>,
): (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError> {
  return (input) =>
    executeRaw(input).pipe(
      withMetrics({
        counter: gitCommandsTotal,
        timer: gitCommandDuration,
        attributes: {
          operation: input.operation,
        },
      }),
      Effect.withSpan(input.operation, {
        kind: "client",
        attributes: {
          "git.operation": input.operation,
          "git.cwd": input.cwd,
          "git.args_count": input.args.length,
        },
      }),
    );
}

// ---------------------------------------------------------------------------
// High-level git helpers
// ---------------------------------------------------------------------------

/**
 * Higher-level git helpers built on top of the raw execute function.
 */
export function makeGitHelpers(
  execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>,
) {
  const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

  const createGitCommandError = (
    operation: string,
    cwd: string,
    args: readonly string[],
    detail: string,
    cause?: unknown,
  ) =>
    new GitCommandError({
      operation,
      command: `git ${args.join(" ")}`,
      cwd,
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<ExecuteGitResult, GitCommandError> =>
    execute({
      operation,
      cwd,
      args,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      allowNonZeroExit: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.truncateOutputAtMaxBytes !== undefined
        ? { truncateOutputAtMaxBytes: options.truncateOutputAtMaxBytes }
        : {}),
      ...(options.progress ? { progress: options.progress } : {}),
    }).pipe(
      Effect.flatMap((result) => {
        if (options.allowNonZeroExit || result.code === 0) {
          return Effect.succeed(result);
        }
        const stderr = result.stderr.trim();
        if (stderr.length > 0) {
          return Effect.fail(createGitCommandError(operation, cwd, args, stderr));
        }
        if (options.fallbackErrorMessage) {
          return Effect.fail(
            createGitCommandError(operation, cwd, args, options.fallbackErrorMessage),
          );
        }
        return Effect.fail(
          createGitCommandError(
            operation,
            cwd,
            args,
            `${commandLabel(args)} failed: code=${result.code ?? "null"}`,
          ),
        );
      }),
    );

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const runGitStdoutWithOptions = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(
      Effect.map((result) =>
        result.stdoutTruncated ? `${result.stdout}${OUTPUT_TRUNCATED_MARKER}` : result.stdout,
      ),
    );

  return { executeGit, runGit, runGitStdout, runGitStdoutWithOptions };
}

export type GitHelpers = ReturnType<typeof makeGitHelpers>;
