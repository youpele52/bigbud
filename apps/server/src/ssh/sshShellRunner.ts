import { Effect } from "effect";

import {
  ThreadShellRunnerError,
  type ThreadShellRunnerShape,
} from "../shell/Services/ThreadShellRunner.ts";
import { runSshCommand } from "./sshProcess.ts";

const SHELL_TIMEOUT_MS = 30_000;
const SHELL_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Run server-dispatched shell commands over SSH without requiring a remote agent. */
export function makeSshShellRunner(executionTargetId: string): ThreadShellRunnerShape {
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
