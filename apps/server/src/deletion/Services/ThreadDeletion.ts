import type {
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Cause, Data, Effect, Layer, Option, Ref, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { DiscoveredThreadDeletionFiles } from "../Layers/ThreadDeletion.files.ts";
import {
  cleanupDiscoveredThreadWorktrees,
  discoverThreadDeletionFiles,
} from "../Layers/ThreadDeletion.files.ts";
import { ServerConfig } from "../../startup/config.ts";

export type ThreadDeletionOutcome =
  | { readonly type: "deleted"; readonly threadIds: ReadonlyArray<ThreadId> }
  | { readonly type: "skipped_active"; readonly threadIds: ReadonlyArray<ThreadId> }
  | { readonly type: "skipped_pinned"; readonly threadIds: ReadonlyArray<ThreadId> }
  | {
      readonly type: "failed";
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly detail: string;
    };

export class ThreadDeletionOperationError extends Data.TaggedError("ThreadDeletionOperationError")<{
  readonly detail: string;
}> {}

export function resolveThreadSubtree(
  rootThreadId: ThreadId,
  threads: ReadonlyArray<OrchestrationThread>,
): ReadonlyArray<OrchestrationThread> {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const rootProjectId = threadsById.get(rootThreadId)?.projectId;
  const descendants = new Map<ThreadId, OrchestrationThread[]>();
  for (const thread of threads) {
    const parentId = thread.parentThread?.threadId;
    if (parentId) {
      const children = descendants.get(parentId) ?? [];
      children.push(thread);
      descendants.set(parentId, children);
    }
  }

  const subtree: OrchestrationThread[] = [];
  const pending = [rootThreadId];
  const seen = new Set<ThreadId>();
  while (pending.length > 0) {
    const threadId = pending.pop()!;
    if (seen.has(threadId)) continue;
    seen.add(threadId);
    const thread = threadsById.get(threadId);
    if (!thread || thread.deletedAt !== null || thread.projectId !== rootProjectId) continue;
    subtree.push(thread);
    for (const child of descendants.get(threadId) ?? []) pending.push(child.id);
  }
  return subtree;
}

export function resolveProjectDeletionRoots(
  projectId: ProjectId,
  threads: ReadonlyArray<OrchestrationThread>,
): ReadonlyArray<OrchestrationThread> {
  const activeThreads = threads.filter(
    (thread) => thread.projectId === projectId && thread.deletedAt === null,
  );
  const activeThreadIds = new Set(activeThreads.map((thread) => thread.id));
  return activeThreads.filter(
    (thread) =>
      thread.parentThread === undefined || !activeThreadIds.has(thread.parentThread.threadId),
  );
}

export function resolveProjectDeletionRequests(
  projectId: ProjectId,
  threads: ReadonlyArray<OrchestrationThread>,
): ReadonlyArray<OrchestrationThread> {
  const roots = resolveProjectDeletionRoots(projectId, threads);
  const deletingRootIds = new Set(
    roots.filter((thread) => thread.deletingAt != null).map((thread) => thread.id),
  );
  const takeoverChildren = threads.filter(
    (thread) =>
      thread.projectId === projectId &&
      thread.deletedAt === null &&
      thread.parentThread !== undefined &&
      deletingRootIds.has(thread.parentThread.threadId),
  );
  return [...roots, ...takeoverChildren];
}

type ThreadDeletionFenceMode = "single" | "subtree";

function isThreadFenced(input: {
  readonly threadId: ThreadId;
  readonly readModel: OrchestrationReadModel;
  readonly fences: ReadonlyMap<ThreadId, ThreadDeletionFenceMode>;
}): boolean {
  const threads = new Map(input.readModel.threads.map((thread) => [thread.id, thread]));
  const threadProjectId = threads.get(input.threadId)?.projectId;
  let currentId: ThreadId | undefined = input.threadId;
  const seen = new Set<ThreadId>();
  while (currentId && !seen.has(currentId)) {
    const mode = input.fences.get(currentId);
    if (mode === "single" && currentId === input.threadId) return true;
    if (mode === "subtree" && threads.get(currentId)?.projectId === threadProjectId) return true;
    seen.add(currentId);
    currentId = threads.get(currentId)?.parentThread?.threadId;
  }
  return false;
}

export interface ThreadDeletionShape {
  readonly acquireFence: (
    rootThreadId: ThreadId,
    mode?: ThreadDeletionFenceMode,
  ) => Effect.Effect<boolean>;
  readonly acquireFences: (
    rootThreadIds: ReadonlyArray<ThreadId>,
    mode?: ThreadDeletionFenceMode,
  ) => Effect.Effect<boolean>;
  readonly isFenceRoot: (
    threadId: ThreadId,
    requiredMode?: ThreadDeletionFenceMode,
  ) => Effect.Effect<boolean>;
  readonly releaseFence: (
    rootThreadId: ThreadId,
    expectedMode?: ThreadDeletionFenceMode,
  ) => Effect.Effect<void>;
  readonly isFenced: (input: {
    readonly threadId: ThreadId;
    readonly readModel: OrchestrationReadModel;
  }) => Effect.Effect<boolean>;
  readonly deleteNow: (input: {
    readonly rootThreadId: ThreadId;
    readonly mode?: "single" | "subtree";
    /** The command processor acquires this before emitting thread.deletion-requested. */
    readonly fenceAlreadyHeld?: boolean;
    readonly resolveThreads: () => Effect.Effect<ReadonlyArray<OrchestrationThread>>;
    readonly preflight: (
      threads: ReadonlyArray<OrchestrationThread>,
    ) => Effect.Effect<"active" | "pinned" | void, ThreadDeletionOperationError>;
    readonly teardown: (
      thread: OrchestrationThread,
    ) => Effect.Effect<void, ThreadDeletionOperationError>;
    readonly finalize: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<void, ThreadDeletionOperationError>;
  }) => Effect.Effect<ThreadDeletionOutcome>;
  readonly discoverFiles: (input: {
    readonly rootThreadId: ThreadId;
    readonly threadIds: ReadonlyArray<ThreadId>;
  }) => Effect.Effect<DiscoveredThreadDeletionFiles, ThreadDeletionOperationError>;
  readonly cleanupWorktrees: (
    files: DiscoveredThreadDeletionFiles,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly resource: string; readonly detail: string }>,
    ThreadDeletionOperationError
  >;
}

export class ThreadDeletion extends ServiceMap.Service<ThreadDeletion, ThreadDeletionShape>()(
  "t3/deletion/Services/ThreadDeletion",
) {}

const makeThreadDeletion = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const config = yield* Effect.serviceOption(ServerConfig);
  const fences = yield* Ref.make<ReadonlyMap<ThreadId, ThreadDeletionFenceMode>>(new Map());
  const acquireFences = (
    rootThreadIds: ReadonlyArray<ThreadId>,
    mode: ThreadDeletionFenceMode = "subtree",
  ) =>
    Ref.modify(fences, (current) => {
      const canAcquire = rootThreadIds.every((rootThreadId) => {
        const heldMode = current.get(rootThreadId);
        return heldMode === undefined || (heldMode === "single" && mode === "subtree");
      });
      if (!canAcquire) return [false, current];
      return [
        true,
        new Map([
          ...current,
          ...rootThreadIds.map((rootThreadId) => [rootThreadId, mode] as const),
        ]),
      ];
    });
  const acquireFence = (rootThreadId: ThreadId, mode: ThreadDeletionFenceMode = "subtree") =>
    acquireFences([rootThreadId], mode);
  const isFenceRoot = (threadId: ThreadId, requiredMode?: ThreadDeletionFenceMode) =>
    Ref.get(fences).pipe(
      Effect.map((current) => {
        const heldMode = current.get(threadId);
        return requiredMode === undefined ? heldMode !== undefined : heldMode === requiredMode;
      }),
    );
  const releaseFence = (rootThreadId: ThreadId, expectedMode?: ThreadDeletionFenceMode) =>
    Ref.update(fences, (current) => {
      const heldMode = current.get(rootThreadId);
      if (expectedMode !== undefined && heldMode !== expectedMode) return current;
      const next = new Map(current);
      next.delete(rootThreadId);
      return next;
    });
  const isFenced: ThreadDeletionShape["isFenced"] = (input) =>
    Ref.get(fences).pipe(
      Effect.map((current) =>
        isThreadFenced({
          threadId: input.threadId,
          readModel: input.readModel,
          fences: current,
        }),
      ),
    );

  const deleteNow: ThreadDeletionShape["deleteNow"] = (input) =>
    Effect.gen(function* () {
      if (
        !input.fenceAlreadyHeld &&
        !(yield* acquireFence(input.rootThreadId, input.mode ?? "subtree"))
      ) {
        const threads =
          input.mode === "single"
            ? (yield* input.resolveThreads()).filter(
                (thread) => thread.id === input.rootThreadId && thread.deletedAt === null,
              )
            : resolveThreadSubtree(input.rootThreadId, yield* input.resolveThreads());
        return {
          type: "failed",
          threadIds: threads.map((thread) => thread.id),
          detail: "already deleting",
        };
      }

      let knownThreadIds: ReadonlyArray<ThreadId> = [input.rootThreadId];
      return yield* Effect.gen(function* () {
        const initialThreads = yield* input.resolveThreads();
        const initial =
          input.mode === "single"
            ? initialThreads.filter(
                (thread) => thread.id === input.rootThreadId && thread.deletedAt === null,
              )
            : resolveThreadSubtree(input.rootThreadId, initialThreads);
        const initialIds = initial.map((thread) => thread.id);
        knownThreadIds = initialIds;
        const firstPreflight = yield* input.preflight(initial);
        if (firstPreflight === "active")
          return { type: "skipped_active" as const, threadIds: initialIds };
        if (firstPreflight === "pinned")
          return { type: "skipped_pinned" as const, threadIds: initialIds };

        const currentThreads = yield* input.resolveThreads();
        const current =
          input.mode === "single"
            ? currentThreads.filter(
                (thread) => thread.id === input.rootThreadId && thread.deletedAt === null,
              )
            : resolveThreadSubtree(input.rootThreadId, currentThreads);
        const currentIds = current.map((thread) => thread.id);
        knownThreadIds = currentIds;
        if (
          initialIds.length !== currentIds.length ||
          initialIds.some((id) => !currentIds.includes(id))
        ) {
          return { type: "skipped_active" as const, threadIds: currentIds };
        }
        const secondPreflight = yield* input.preflight(current);
        if (secondPreflight === "active")
          return { type: "skipped_active" as const, threadIds: currentIds };
        if (secondPreflight === "pinned")
          return { type: "skipped_pinned" as const, threadIds: currentIds };

        yield* Effect.forEach(current, input.teardown, { concurrency: 1, discard: true });
        yield* input.finalize(currentIds);
        return { type: "deleted" as const, threadIds: currentIds };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed({
            type: "failed" as const,
            threadIds: knownThreadIds,
            detail: Cause.pretty(cause),
          }),
        ),
        Effect.tap((outcome) =>
          outcome.type === "deleted"
            ? Effect.void
            : releaseFence(input.rootThreadId, input.mode ?? "subtree"),
        ),
      );
    });

  const unavailableFiles = new ThreadDeletionOperationError({
    detail: "thread deletion file services are unavailable",
  });
  const discoverFiles: ThreadDeletionShape["discoverFiles"] = (input) =>
    Option.isSome(sql) && Option.isSome(config)
      ? discoverThreadDeletionFiles(input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql.value),
          Effect.provideService(ServerConfig, config.value),
          Effect.mapError((error) => new ThreadDeletionOperationError({ detail: String(error) })),
        )
      : Effect.fail(unavailableFiles);
  const cleanupWorktrees: ThreadDeletionShape["cleanupWorktrees"] = (files) =>
    Option.isSome(config)
      ? cleanupDiscoveredThreadWorktrees(files).pipe(
          Effect.provideService(ServerConfig, config.value),
          Effect.mapError((error) => new ThreadDeletionOperationError({ detail: String(error) })),
        )
      : Effect.succeed([]);

  return {
    acquireFence,
    acquireFences,
    isFenceRoot,
    releaseFence,
    isFenced,
    deleteNow,
    discoverFiles,
    cleanupWorktrees,
  } satisfies ThreadDeletionShape;
});

export const ThreadDeletionLive = Layer.effect(ThreadDeletion, makeThreadDeletion);
