import { SSH_OWNER_PRODUCTION_ACTIVATION } from "@bigbud/shared/SshOwnerActivation";
import { Effect } from "effect";

import {
  ThreadShellRunnerError,
  type ThreadShellRunnerShape,
} from "../shell/Services/ThreadShellRunner.ts";
import { isSshOwnerDevFixtureSelected } from "./sshOwnerSelection.ts";
import {
  boundedTimeout,
  ownerShellError,
  truncateShellOutput,
  type SshShellOwnerAccess,
} from "./sshShellRunner.owner.ts";
import { runSshCommand } from "./sshProcess.ts";
import { makeProductionShellRunner } from "./sshShellRunner.production.ts";

const SHELL_TIMEOUT_MS = 30_000;
const SHELL_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

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
  activation: boolean = SSH_OWNER_PRODUCTION_ACTIVATION,
): ThreadShellRunnerShape {
  if (isSshOwnerDevFixtureSelected()) {
    return makeOwnerRunner(executionTargetId, ownerAccess);
  }
  // W2 T-shell: production activation runs the owner exec lease; no legacy launch.
  if (activation) return makeProductionShellRunner(executionTargetId);
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
