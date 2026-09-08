import { createHash, randomUUID } from "node:crypto";

import { Cause, Effect, Queue, Stream } from "effect";
import type {
  ProjectDirectoryWatchBackend,
  ProjectDirectoryWatchEvent,
  ProjectDirectoryWatchInput,
} from "@bigbud/contracts/workspace/project.ts";

import { WorkspaceFileSystemError } from "../workspace/Services/WorkspaceFileSystem.ts";
import type { WorkspaceWatchShape } from "../workspace-runtime/Services/WorkspaceWatch.ts";
import { LocalWorkspaceWatchAgentUnavailableError } from "./localWorkspaceWatchAgent.binary.ts";
import type { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import type { RemoteAgentWorkspaceWatchEvent } from "./remoteAgentProtocol.ts";
import { RemoteAgentCapabilityError } from "./remoteAgentConnectionPool.ts";
import { RemoteAgentWorkspaceWatchStartError } from "./remoteAgentWorkspaceWatchClient.ts";

const DEFAULT_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface AgentWorkspaceWatchResolver {
  readonly resolve: (targetId: string) => Promise<RemoteAgentWorkspaceClient>;
}

export interface AgentWorkspaceWatchTarget {
  readonly id: (executionTargetId: string | undefined) => string;
  readonly workspaceIdentity?: (cwd: string) => Promise<string>;
  readonly operation: string;
}

export interface AgentWorkspaceWatchOptions {
  readonly reconnectDelayMs?: number;
}

function stableId(value: unknown): string {
  return `watch-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

function watchError(input: {
  readonly cwd: string;
  readonly relativePath?: string;
  readonly operation: string;
  readonly cause: unknown;
  readonly retryable?: boolean;
}): WorkspaceFileSystemError {
  return new WorkspaceFileSystemError({
    cwd: input.cwd,
    ...(input.relativePath !== undefined ? { relativePath: input.relativePath } : {}),
    operation: input.operation,
    detail: input.cause instanceof Error ? input.cause.message : String(input.cause),
    retryable: input.retryable ?? true,
    cause: input.cause,
  });
}

function reconnectDelay(baseDelayMs: number, failureCount: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, baseDelayMs * 2 ** Math.min(failureCount, 8));
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

function waitForAbort(signal: AbortSignal): {
  readonly promise: Promise<Error>;
  readonly cancel: () => void;
} {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<Error>((resolve) => {
    if (signal.aborted) return resolve(new Error("watch stopped"));
    onAbort = () => resolve(new Error("watch stopped"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cancel: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

function rescanEvent(input: {
  readonly relativePath: string;
  readonly generation: number;
  readonly sequence: number;
  readonly reason: "transportLost" | "agentRestarted" | "overflow" | "watchInvalidated";
  readonly backend?: ProjectDirectoryWatchBackend;
}): ProjectDirectoryWatchEvent {
  return { version: 2, type: "rescanRequired", ...input };
}

function rustWatchBackend(value: string): ProjectDirectoryWatchBackend {
  return value === "poll" ? "poll" : "native";
}

function projectEvent(
  relativePath: string,
  event: RemoteAgentWorkspaceWatchEvent,
  fallbackBackend: ProjectDirectoryWatchBackend,
): ProjectDirectoryWatchEvent {
  const backend = event.backend ? rustWatchBackend(event.backend) : fallbackBackend;
  if (event.rescanRequired) {
    const reason = event.rescanReason === "watchInvalidated" ? "watchInvalidated" : "overflow";
    return rescanEvent({
      relativePath,
      generation: event.generation,
      sequence: event.sequence,
      reason,
      backend,
    });
  }
  return {
    version: 2,
    type: "directoryChanged",
    relativePath,
    changedPaths: event.changes.map((change) => change.path),
    generation: event.generation,
    sequence: event.sequence,
    backend,
  };
}

function isPermanentlyUnavailable(cause: unknown): boolean {
  return (
    cause instanceof LocalWorkspaceWatchAgentUnavailableError ||
    cause instanceof RemoteAgentCapabilityError ||
    (cause instanceof RemoteAgentWorkspaceWatchStartError && !cause.retryable)
  );
}

export function makeAgentWorkspaceWatch(
  resolver: AgentWorkspaceWatchResolver,
  target: AgentWorkspaceWatchTarget,
  options: AgentWorkspaceWatchOptions = {},
): WorkspaceWatchShape {
  const reconnectDelayMs = Math.max(
    50,
    Math.floor(options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS),
  );

  const watchDirectory: WorkspaceWatchShape["watchDirectory"] = Effect.fn(
    "AgentWorkspaceWatch.watchDirectory",
  )(function* (input: ProjectDirectoryWatchInput) {
    const targetId = yield* Effect.try({
      try: () => target.id(input.executionTargetId),
      catch: (cause) =>
        watchError({
          cwd: input.cwd,
          ...(input.relativePath !== undefined ? { relativePath: input.relativePath } : {}),
          operation: target.operation,
          cause,
        }),
    });
    const workspaceRoot = yield* Effect.tryPromise({
      try: () => target.workspaceIdentity?.(input.cwd) ?? Promise.resolve(input.cwd),
      catch: (cause) =>
        watchError({
          cwd: input.cwd,
          ...(input.relativePath !== undefined ? { relativePath: input.relativePath } : {}),
          operation: target.operation,
          cause,
          retryable: false,
        }),
    });
    const relativePath = input.relativePath ?? "";
    const workspaceHandle = stableId({ targetId, cwd: workspaceRoot });

    return Stream.callback<ProjectDirectoryWatchEvent, WorkspaceFileSystemError>(
      (queue) =>
        Effect.gen(function* () {
          const services = yield* Effect.services();
          const runFork = Effect.runForkWith(services);
          let overflowScheduled = false;
          let currentBackend: ProjectDirectoryWatchBackend = "native";
          const offer = (event: ProjectDirectoryWatchEvent) => {
            if (Queue.offerUnsafe(queue, event) || overflowScheduled) return;
            overflowScheduled = true;
            const overflow = rescanEvent({
              relativePath,
              generation: event.generation ?? 0,
              sequence: event.version === 2 ? event.sequence : 0,
              reason: "overflow",
              backend: currentBackend,
            });
            runFork(
              Queue.offer(queue, overflow).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    overflowScheduled = false;
                  }),
                ),
              ),
            );
          };
          const abortController = new AbortController();
          let closeActive: (() => Promise<void>) | undefined;
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              abortController.abort();
              await closeActive?.();
              Queue.endUnsafe(queue);
            }),
          );

          yield* Effect.promise(async () => {
            let recoveryRequired = false;
            let lastGeneration = 0;
            let lastSequence = 0;
            let consecutiveStartFailures = 0;
            while (!abortController.signal.aborted) {
              try {
                const client = await resolver.resolve(targetId);
                await client.openWorkspace(workspaceHandle, workspaceRoot);
                let receivedEventBeforeStart = false;
                const subscription = await client.watchDirectory({
                  subscriptionId: randomUUID(),
                  workspaceHandle,
                  path: relativePath || ".",
                  onEvent: (event) => {
                    receivedEventBeforeStart = true;
                    const continuityLost =
                      (lastGeneration !== 0 && event.generation !== lastGeneration) ||
                      (event.generation === lastGeneration &&
                        lastSequence !== 0 &&
                        event.sequence !== lastSequence + 1);
                    lastGeneration = event.generation;
                    lastSequence = event.sequence;
                    const nextBackend = event.backend
                      ? rustWatchBackend(event.backend)
                      : currentBackend;
                    if (nextBackend !== currentBackend) {
                      currentBackend = nextBackend;
                      runFork(
                        Effect.logInfo("Workspace watcher backend changed").pipe(
                          Effect.annotateLogs({ targetId, workspaceRoot, backend: currentBackend }),
                        ),
                      );
                    }
                    offer(
                      continuityLost
                        ? rescanEvent({
                            relativePath,
                            generation: event.generation,
                            sequence: event.sequence,
                            reason: "watchInvalidated",
                            backend: currentBackend,
                          })
                        : projectEvent(relativePath, event, currentBackend),
                    );
                  },
                });
                closeActive = subscription.close;
                consecutiveStartFailures = 0;
                if (!receivedEventBeforeStart) {
                  lastGeneration = subscription.started.generation;
                  lastSequence = 0;
                  currentBackend = rustWatchBackend(subscription.started.backend);
                }
                runFork(
                  Effect.logInfo("Workspace watcher started").pipe(
                    Effect.annotateLogs({ targetId, workspaceRoot, backend: currentBackend }),
                  ),
                );
                if (recoveryRequired) {
                  offer(
                    rescanEvent({
                      relativePath,
                      generation: lastGeneration,
                      sequence: 0,
                      reason: "agentRestarted",
                      backend: currentBackend,
                    }),
                  );
                  recoveryRequired = false;
                }
                const abortWait = waitForAbort(abortController.signal);
                await Promise.race([subscription.failed, abortWait.promise]);
                abortWait.cancel();
                await subscription.close();
                closeActive = undefined;
                if (abortController.signal.aborted) break;
                recoveryRequired = true;
                offer(
                  rescanEvent({
                    relativePath,
                    generation: lastGeneration,
                    sequence: lastSequence,
                    reason: "transportLost",
                    backend: currentBackend,
                  }),
                );
              } catch (cause) {
                if (isPermanentlyUnavailable(cause)) {
                  Queue.failCauseUnsafe(
                    queue,
                    Cause.fail(
                      watchError({
                        cwd: input.cwd,
                        ...(input.relativePath !== undefined
                          ? { relativePath: input.relativePath }
                          : {}),
                        operation: target.operation,
                        cause,
                        retryable: false,
                      }),
                    ),
                  );
                  return;
                }
                consecutiveStartFailures += 1;
                if (!recoveryRequired) {
                  recoveryRequired = true;
                  offer(
                    rescanEvent({
                      relativePath,
                      generation: lastGeneration,
                      sequence: lastSequence,
                      reason: "transportLost",
                      backend: currentBackend,
                    }),
                  );
                }
              }
              await wait(
                reconnectDelay(reconnectDelayMs, consecutiveStartFailures),
                abortController.signal,
              );
            }
            Queue.endUnsafe(queue);
          });
        }),
      { bufferSize: 64, strategy: "suspend" },
    );
  });

  return { watchDirectory };
}
