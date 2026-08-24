import { Effect, Queue, Stream } from "effect";

import type { ProjectDirectoryWatchEvent } from "@bigbud/contracts/workspace/project.ts";

import { runSshCommand } from "../../ssh/sshProcess.ts";
import { WorkspaceFileSystemError } from "../Services/WorkspaceFileSystem.ts";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const REMOTE_DIRECTORY_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const REMOTE_DIRECTORY_SNAPSHOT_TIMEOUT_MS = 10_000;

interface RemoteDirectoryPollingInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly readSnapshot: () => Promise<string>;
  readonly pollIntervalMs?: number;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelay(pollIntervalMs: number, failureCount: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, pollIntervalMs * 2 ** Math.min(failureCount, 8));
}

export function createRemoteDirectoryPollingStream(
  input: RemoteDirectoryPollingInput,
): Stream.Stream<ProjectDirectoryWatchEvent, WorkspaceFileSystemError> {
  const pollIntervalMs = Math.max(10, Math.floor(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));

  return Stream.callback<ProjectDirectoryWatchEvent, WorkspaceFileSystemError>(
    (queue) =>
      Effect.gen(function* () {
        const abortController = new AbortController();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            abortController.abort();
            Queue.endUnsafe(queue);
          }),
        );

        yield* Effect.promise(async () => {
          let previousSnapshot: string | undefined;
          let disconnected = false;
          let failureCount = 0;
          let generation = 0;

          while (!abortController.signal.aborted) {
            try {
              const nextSnapshot = await input.readSnapshot();
              failureCount = 0;

              if (disconnected) {
                generation += 1;
                Queue.offerUnsafe(queue, {
                  version: 1,
                  type: "directoryChanged",
                  relativePath: input.relativePath,
                  generation,
                });
                disconnected = false;
              } else if (previousSnapshot !== undefined && previousSnapshot !== nextSnapshot) {
                generation += 1;
                Queue.offerUnsafe(queue, {
                  version: 1,
                  type: "directoryChanged",
                  relativePath: input.relativePath,
                  generation,
                });
              }
              previousSnapshot = nextSnapshot;
            } catch {
              failureCount += 1;
              previousSnapshot = undefined;
              if (!disconnected) {
                generation += 1;
                Queue.offerUnsafe(queue, {
                  version: 1,
                  type: "rescanRequired",
                  relativePath: input.relativePath,
                  generation,
                  reason: "transportLost",
                });
                disconnected = true;
              }
            }

            await wait(
              failureCount > 0 ? retryDelay(pollIntervalMs, failureCount) : pollIntervalMs,
              abortController.signal,
            );
          }
          Queue.endUnsafe(queue);
        });
      }),
    { bufferSize: 8, strategy: "suspend" },
  );
}

export function watchRemoteDirectoryViaSsh(input: {
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly relativePath: string;
}): Stream.Stream<ProjectDirectoryWatchEvent, WorkspaceFileSystemError> {
  return createRemoteDirectoryPollingStream({
    cwd: input.cwd,
    relativePath: input.relativePath,
    readSnapshot: async () => {
      const findRoot = input.relativePath ? `./${input.relativePath}` : ".";
      const result = await runSshCommand({
        executionTargetId: input.executionTargetId,
        cwd: input.cwd,
        command: "find",
        args: [
          findRoot,
          "-mindepth",
          "1",
          "-maxdepth",
          "1",
          "(",
          "-type",
          "d",
          "-o",
          "-type",
          "f",
          ")",
          "-printf",
          "%y\\t%P\\t%s\\t%T@\\0",
        ],
        timeoutMs: REMOTE_DIRECTORY_SNAPSHOT_TIMEOUT_MS,
        maxBufferBytes: REMOTE_DIRECTORY_SNAPSHOT_MAX_BYTES,
        outputMode: "truncate",
      });
      if (result.stdoutTruncated) {
        throw new Error("Remote directory snapshot exceeded the 4 MiB safety limit.");
      }
      return result.stdout.split("\0").filter(Boolean).toSorted().join("\0");
    },
  });
}
