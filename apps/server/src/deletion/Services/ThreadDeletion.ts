import type { OrchestrationReadModel, OrchestrationThread, ThreadId } from "@bigbud/contracts";
import { Cause, Data, Effect, Layer, Option, Ref, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { DiscoveredThreadDeletionFiles } from "../Layers/ThreadDeletion.files.ts";
import {
  cleanupDiscoveredThreadDeletionFiles,
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
    if (!thread || thread.deletedAt !== null) continue;
    subtree.push(thread);
    for (const child of descendants.get(threadId) ?? []) pending.push(child.id);
  }
  return subtree;
}

function hasFencedAncestor(input: {
  readonly threadId: ThreadId;
  readonly readModel: OrchestrationReadModel;
  readonly fencedRoots: ReadonlySet<ThreadId>;
}): boolean {
  const threads = new Map(input.readModel.threads.map((thread) => [thread.id, thread]));
  let currentId: ThreadId | undefined = input.threadId;
  const seen = new Set<ThreadId>();
  while (currentId && !seen.has(currentId)) {
    if (input.fencedRoots.has(currentId)) return true;
    seen.add(currentId);
    currentId = threads.get(currentId)?.parentThread?.threadId;
  }
  return false;
}

export interface ThreadDeletionShape {
  readonly acquireFence: (rootThreadId: ThreadId) => Effect.Effect<boolean>;
  readonly acquireFences: (rootThreadIds: ReadonlyArray<ThreadId>) => Effect.Effect<boolean>;
  readonly isFenceRoot: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly releaseFence: (rootThreadId: ThreadId) => Effect.Effect<void>;
  readonly isFenced: (input: {
    readonly threadId: ThreadId;
    readonly readModel: OrchestrationReadModel;
  }) => Effect.Effect<boolean>;
  readonly deleteNow: (input: {
    readonly rootThreadId: ThreadId;
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
  readonly cleanupFiles: (
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
  const fencedRoots = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  const acquireFences = (rootThreadIds: ReadonlyArray<ThreadId>) =>
    Ref.modify(fencedRoots, (roots) =>
      rootThreadIds.some((rootThreadId) => roots.has(rootThreadId))
        ? [false, roots]
        : [true, new Set([...roots, ...rootThreadIds]) as ReadonlySet<ThreadId>],
    );
  const acquireFence = (rootThreadId: ThreadId) => acquireFences([rootThreadId]);
  const isFenceRoot = (threadId: ThreadId) =>
    Ref.get(fencedRoots).pipe(Effect.map((roots) => roots.has(threadId)));
  const releaseFence = (rootThreadId: ThreadId) =>
    Ref.update(fencedRoots, (roots) => {
      const next = new Set(roots);
      next.delete(rootThreadId);
      return next;
    });
  const isFenced: ThreadDeletionShape["isFenced"] = (input) =>
    Ref.get(fencedRoots).pipe(
      Effect.map((roots) =>
        hasFencedAncestor({
          threadId: input.threadId,
          readModel: input.readModel,
          fencedRoots: roots,
        }),
      ),
    );

  const deleteNow: ThreadDeletionShape["deleteNow"] = (input) =>
    Effect.gen(function* () {
      if (!input.fenceAlreadyHeld && !(yield* acquireFence(input.rootThreadId))) {
        const threads = resolveThreadSubtree(input.rootThreadId, yield* input.resolveThreads());
        return {
          type: "failed",
          threadIds: threads.map((thread) => thread.id),
          detail: "already deleting",
        };
      }

      let knownThreadIds: ReadonlyArray<ThreadId> = [input.rootThreadId];
      return yield* Effect.gen(function* () {
        const initial = resolveThreadSubtree(input.rootThreadId, yield* input.resolveThreads());
        const initialIds = initial.map((thread) => thread.id);
        knownThreadIds = initialIds;
        const firstPreflight = yield* input.preflight(initial);
        if (firstPreflight === "active")
          return { type: "skipped_active" as const, threadIds: initialIds };
        if (firstPreflight === "pinned")
          return { type: "skipped_pinned" as const, threadIds: initialIds };

        const current = resolveThreadSubtree(input.rootThreadId, yield* input.resolveThreads());
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
          outcome.type === "deleted" ? Effect.void : releaseFence(input.rootThreadId),
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
  const cleanupFiles: ThreadDeletionShape["cleanupFiles"] = (files) =>
    Option.isSome(config)
      ? cleanupDiscoveredThreadDeletionFiles(files).pipe(
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
    cleanupFiles,
  } satisfies ThreadDeletionShape;
});

export const ThreadDeletionLive = Layer.effect(ThreadDeletion, makeThreadDeletion);
