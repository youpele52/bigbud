import { createHash } from "node:crypto";

import { Effect, Queue, Stream } from "effect";
import type {
  ProjectDirectoryWatchEvent,
  ProjectDirectoryWatchInput,
} from "@bigbud/contracts/workspace/project.ts";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import { WorkspaceFileSystemError } from "../workspace/Services/WorkspaceFileSystem.ts";
import type { WorkspaceWatchShape } from "../workspace-runtime/Services/WorkspaceWatch.ts";
import type { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_MS = 5 * 60_000;

export interface RemoteWorkspaceWatchResolver {
  readonly resolve: (executionTargetId: string) => Promise<RemoteAgentWorkspaceClient>;
}

export interface RemoteWorkspaceWatchOptions {
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
}

function targetId(executionTargetId: string | undefined): string {
  const target = executionTargetId ?? "local";
  if (isLocalExecutionTarget(target)) {
    throw new Error("The remote workspace watcher requires an SSH execution target.");
  }
  return target;
}

function stableId(value: unknown): string {
  return `watch-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

function directorySnapshot(
  entries: ReadonlyArray<{
    readonly path: string;
    readonly isDirectory: boolean;
    readonly isFile: boolean;
    readonly sizeBytes: number;
    readonly modifiedUnixMs?: number;
  }>,
): string {
  return JSON.stringify(
    entries
      .map((entry) => [
        entry.path,
        entry.isDirectory,
        entry.isFile,
        entry.sizeBytes,
        entry.modifiedUnixMs ?? 0,
      ])
      .toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );
}

function watchError(input: {
  readonly cwd: string;
  readonly relativePath?: string;
  readonly cause: unknown;
}): WorkspaceFileSystemError {
  return new WorkspaceFileSystemError({
    cwd: input.cwd,
    ...(input.relativePath !== undefined ? { relativePath: input.relativePath } : {}),
    operation: "remoteWorkspace.watchDirectory",
    detail: input.cause instanceof Error ? input.cause.message : String(input.cause),
    cause: input.cause,
  });
}

function waitForNextPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function rescanEvent(
  relativePath: string,
  generation: number,
  reason: "transportLost" | "agentRestarted" | "leaseExpired" | "overflow",
): ProjectDirectoryWatchEvent {
  return {
    version: 1,
    type: "rescanRequired",
    relativePath,
    generation,
    reason,
  };
}

export function makeRemoteWorkspaceWatch(
  resolver: RemoteWorkspaceWatchResolver,
  options: RemoteWorkspaceWatchOptions = {},
): WorkspaceWatchShape {
  const pollIntervalMs = Math.max(
    50,
    Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  );
  const leaseMs = Math.max(pollIntervalMs, Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS));

  const watchDirectory: WorkspaceWatchShape["watchDirectory"] = Effect.fn(
    "RemoteWorkspaceWatch.watchDirectory",
  )(function* (input: ProjectDirectoryWatchInput) {
    const target = yield* Effect.try({
      try: () => targetId(input.executionTargetId),
      catch: (cause) =>
        watchError({
          cwd: input.cwd,
          ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
          cause,
        }),
    });
    const relativePath = input.relativePath ?? "";
    const operationId = stableId({ target, cwd: input.cwd, relativePath });
    const requestDigest = new TextEncoder().encode(
      JSON.stringify({ target, cwd: input.cwd, relativePath }),
    );

    return Stream.callback<ProjectDirectoryWatchEvent, WorkspaceFileSystemError>((queue) =>
      Effect.gen(function* () {
        const abortController = new AbortController();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            abortController.abort();
            Queue.endUnsafe(queue);
          }),
        );

        yield* Effect.promise(async () => {
          let generation = 0;
          let previousSnapshot: string | undefined;
          let disconnected = false;
          const expiresAt = Date.now() + leaseMs;

          while (!abortController.signal.aborted) {
            if (Date.now() >= expiresAt) {
              generation += 1;
              Queue.offerUnsafe(queue, rescanEvent(relativePath, generation, "leaseExpired"));
              Queue.endUnsafe(queue);
              return;
            }

            try {
              const client = await resolver.resolve(target);
              const workspaceHandle = stableId({ target, cwd: input.cwd });
              await client.openWorkspace(workspaceHandle, input.cwd);
              const entries = await client.listDirectory({
                workspaceHandle,
                path: relativePath || ".",
                operationId,
                requestDigest,
              });
              const nextSnapshot = directorySnapshot(entries);

              if (disconnected) {
                generation += 1;
                Queue.offerUnsafe(queue, rescanEvent(relativePath, generation, "agentRestarted"));
                disconnected = false;
                previousSnapshot = undefined;
              }
              if (previousSnapshot === undefined || previousSnapshot !== nextSnapshot) {
                generation += 1;
                Queue.offerUnsafe(queue, {
                  version: 1,
                  type: "directoryChanged",
                  relativePath,
                  generation,
                });
                previousSnapshot = nextSnapshot;
              }
            } catch {
              if (!disconnected) {
                generation += 1;
                Queue.offerUnsafe(queue, rescanEvent(relativePath, generation, "transportLost"));
                disconnected = true;
                previousSnapshot = undefined;
              }
            }

            await waitForNextPoll(pollIntervalMs, abortController.signal);
          }
          Queue.endUnsafe(queue);
        });
      }),
    );
  });

  return { watchDirectory };
}
