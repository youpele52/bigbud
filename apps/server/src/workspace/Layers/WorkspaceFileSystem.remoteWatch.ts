import { Effect, Queue, Stream } from "effect";

import type { ProjectDirectoryWatchEvent } from "@bigbud/contracts/workspace/project.ts";

import { SshOwnerRequiredError } from "../../ssh/sshOwnerRequired.ts";
import { WorkspaceFileSystemError } from "../Services/WorkspaceFileSystem.ts";
import type {
  WorkspaceMutationWatchOwnerInput,
  WorkspaceMutationWatchOwnerShape,
} from "../Services/WorkspaceMutationWatchOwner.ts";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

interface RemoteDirectoryPollingInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly readSnapshot: (signal: AbortSignal) => Promise<string>;
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
        yield* Effect.logInfo("Workspace watcher started").pipe(
          Effect.annotateLogs({
            cwd: input.cwd,
            relativePath: input.relativePath,
            backend: "directSshPoll",
          }),
        );
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
          const offer = async (event: ProjectDirectoryWatchEvent) => {
            try {
              await Effect.runPromise(Queue.offer(queue, event), {
                signal: abortController.signal,
              });
            } catch (cause) {
              if (!abortController.signal.aborted) throw cause;
            }
          };

          while (!abortController.signal.aborted) {
            try {
              const nextSnapshot = await input.readSnapshot(abortController.signal);
              if (abortController.signal.aborted) break;
              failureCount = 0;

              // The preview may predate the first successful snapshot or a reconnect.
              if (disconnected || previousSnapshot === undefined) {
                generation += 1;
                await offer({
                  version: 1,
                  type: "directoryChanged",
                  relativePath: input.relativePath,
                  generation,
                  backend: "directSshPoll",
                });
                disconnected = false;
              } else if (previousSnapshot !== undefined && previousSnapshot !== nextSnapshot) {
                generation += 1;
                await offer({
                  version: 1,
                  type: "directoryChanged",
                  relativePath: input.relativePath,
                  generation,
                  backend: "directSshPoll",
                });
              }
              previousSnapshot = nextSnapshot;
            } catch {
              if (abortController.signal.aborted) break;
              failureCount += 1;
              previousSnapshot = undefined;
              if (!disconnected) {
                generation += 1;
                await offer({
                  version: 1,
                  type: "rescanRequired",
                  relativePath: input.relativePath,
                  generation,
                  reason: "transportLost",
                  backend: "directSshPoll",
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

export function watchRemoteDirectoryViaSsh(
  input: WorkspaceMutationWatchOwnerInput,
  owner?: Pick<WorkspaceMutationWatchOwnerShape, "snapshotDirectory">,
): Stream.Stream<ProjectDirectoryWatchEvent, WorkspaceFileSystemError> {
  if (owner) {
    return createRemoteDirectoryPollingStream({
      ...input,
      readSnapshot: (signal) => owner.snapshotDirectory(input, signal),
    });
  }
  // Without the owner's snapshot verb the watch fails typed; SSH runs only through the owner.
  return Stream.fail(
    new WorkspaceFileSystemError({
      cwd: input.cwd,
      relativePath: input.relativePath,
      operation: "workspaceFileSystem.watchRemoteDirectory",
      detail: new SshOwnerRequiredError().message,
    }),
  );
}
