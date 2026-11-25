import { Effect } from "effect";

import {
  ThreadShellRunnerError,
  type ThreadShellRunnerShape,
} from "../shell/Services/ThreadShellRunner.ts";
import { isSshOwnerDevFixtureSelected } from "./sshOwnerSelection.ts";
import {
  THREAD_SHELL_DEFAULT_TIMEOUT_MS,
  THREAD_SHELL_MAX_TIMEOUT_MS,
  truncateShellOutput,
  type SshShellOwnerAccess,
} from "./sshShellRunner.owner.ts";
import { runSshCommand } from "./sshProcess.ts";

const SHELL_TIMEOUT_MS = 30_000;
const SHELL_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function boundedTimeout(timeoutMs: number | null | undefined): number {
  if (timeoutMs === null || timeoutMs === undefined || timeoutMs <= 0) {
    return THREAD_SHELL_DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(Math.floor(timeoutMs), THREAD_SHELL_MAX_TIMEOUT_MS));
}

function ownerShellError(cause: unknown): string {
  if (cause instanceof Error && "code" in cause) {
    switch ((cause as { code?: unknown }).code) {
      case "shellTimedOut":
        return "The remote shell command timed out. The owner lease was terminated and the command was not replayed.";
      case "shellCancelled":
        return "The remote shell command was cancelled for this thread. It was not replayed.";
      case "outcomeUnknown":
        return "The remote shell outcome is unknown. The command was not replayed.";
      case "workspacePathDenied":
        return "The remote shell workspace or cwd was refused by the owner.";
      case "ownerUnavailable":
        return "The SSH owner is unavailable. No legacy shell was started.";
    }
  }
  return cause instanceof Error ? cause.message : "Failed to run shell command over the SSH owner.";
}

function makeOwnerRunner(
  executionTargetId: string,
  access: SshShellOwnerAccess | undefined,
): ThreadShellRunnerShape {
  const activeThreads = new Set<string>();
  const fail = (message: string) => new ThreadShellRunnerError({ message, cause: undefined });

  return {
    isActive: (threadId) => Effect.sync(() => activeThreads.has(threadId)),
    run: (input) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (!access || access.targetId !== executionTargetId) {
            throw fail(
              "Only the exact selected development SSH workspace admits a direct thread shell. No command was launched.",
            );
          }
          if (activeThreads.has(input.threadId)) {
            throw new Error("A direct SSH shell command is already running for this thread.");
          }
          activeThreads.add(input.threadId);
          try {
            const result = await access.withOwner(
              access.targetId,
              (owner) =>
                owner.runProofThreadShell(
                  {
                    workspaceRoot: access.workspaceRoot,
                    cwd: input.cwd,
                    threadId: input.threadId,
                    command: input.command,
                    timeoutMs: boundedTimeout(input.timeoutMs),
                  },
                  signal,
                ),
              signal,
            );
            if (result.timedOut) {
              throw new Error(
                "The remote shell command timed out. The owner lease was terminated and the command was not replayed.",
              );
            }
            const { output } = truncateShellOutput(result.output);
            if (output.length > 0) input.onOutputChunk?.(output);
            return { output, exitCode: result.exitCode };
          } finally {
            activeThreads.delete(input.threadId);
          }
        },
        catch: (cause) => new ThreadShellRunnerError({ message: ownerShellError(cause), cause }),
      }),
    closeThread: () => Effect.void,
  };
}

/** Run server-dispatched shell commands without requiring a remote agent. */
export function makeSshShellRunner(
  executionTargetId: string,
  ownerAccess?: SshShellOwnerAccess,
): ThreadShellRunnerShape {
  if (isSshOwnerDevFixtureSelected()) {
    return makeOwnerRunner(executionTargetId, ownerAccess);
  }
  const activeThreads = new Set<string>();

  return {
    isActive: (threadId) => Effect.sync(() => activeThreads.has(threadId)),
    run: (input) =>
      Effect.tryPromise({
        try: async () => {
          if (activeThreads.has(input.threadId)) {
            throw new Error("A direct SSH shell command is already running for this thread.");
          }
          activeThreads.add(input.threadId);
          try {
            const result = await runSshCommand({
              executionTargetId,
              cwd: input.cwd,
              command: "sh",
              args: ["-lc", input.command],
              allowNonZeroExit: true,
              timeoutMs: input.timeoutMs ?? SHELL_TIMEOUT_MS,
              maxBufferBytes: SHELL_MAX_BUFFER_BYTES,
              outputMode: "truncate",
            });
            const output = `${result.stdout}${result.stderr}`;
            if (output.length > 0) input.onOutputChunk?.(output);
            return {
              output,
              exitCode: result.code,
            };
          } finally {
            activeThreads.delete(input.threadId);
          }
        },
        catch: (cause) =>
          new ThreadShellRunnerError({
            message:
              cause instanceof Error ? cause.message : "Failed to run shell command over SSH.",
            cause,
          }),
      }),
    closeThread: () => Effect.void,
  };
}
