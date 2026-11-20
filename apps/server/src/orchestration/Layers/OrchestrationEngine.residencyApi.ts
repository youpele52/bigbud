import type { OrchestrationReadModel, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import type { Semaphore } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ThreadDeletionShape } from "../../deletion/Services/ThreadDeletion.ts";
import { withMetadataTransaction } from "../../persistence/Layers/ThreadMetadataGeneration.transaction.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type { ProjectionOperationalStateQueryShape } from "../Services/ProjectionOperationalStateQuery.ts";
import type { ThreadStateHydrator } from "./OrchestrationEngine.hydration.ts";
import type { ThreadResidency } from "./OrchestrationEngine.residency.ts";

type ResidencyApi = Pick<
  OrchestrationEngineShape,
  | "withThreadHistoryBarrier"
  | "ensureThreadState"
  | "getThread"
  | "ensureProjectState"
  | "ensureWorkspaceProjects"
  | "ensureProjectThreads"
  | "ensureThreadSubtree"
  | "listProjectThreadIds"
  | "evictIdleThreads"
>;

/**
 * The engine's hydration-backed accessors and its eviction. Every read-model mutation (install,
 * evict) happens under the command barrier; resident hits in `getThread` read without it.
 */
export function makeReadModelResidencyApi(input: {
  readonly hydrator: ThreadStateHydrator;
  readonly residency: ThreadResidency;
  readonly query: ProjectionOperationalStateQueryShape;
  readonly commandSemaphore: Semaphore.Semaphore;
  readonly workspaceSql: SqlClient.SqlClient;
  readonly threadDeletion: Pick<ThreadDeletionShape, "isFenced">;
  readonly readModel: () => OrchestrationReadModel;
  readonly nowMs?: () => number;
}): ResidencyApi {
  const { hydrator, commandSemaphore } = input;
  const barrier = commandSemaphore.withPermits(1);
  const nowMs = input.nowMs ?? Date.now;
  const residentThreads = () => input.readModel().threads;

  const isThreadOperational = input.query.isThreadOperational;
  const evictIdleThreads: ResidencyApi["evictIdleThreads"] =
    isThreadOperational === undefined
      ? undefined
      : ({ isHeld }) =>
          barrier(
            Effect.gen(function* () {
              const readModel = input.readModel();
              const candidates = input.residency.selectCandidates(readModel.threads, nowMs());
              const evicted = new Set<ThreadId>();
              for (const threadId of candidates) {
                if (yield* isHeld(threadId)) continue;
                if (yield* input.threadDeletion.isFenced({ threadId, readModel })) continue;
                // The startup predicate, per thread: an evicted thread is one a restart omits.
                if (yield* isThreadOperational(threadId)) continue;
                evicted.add(threadId);
              }
              hydrator.evict(evicted);
              return { evicted: evicted.size, resident: input.readModel().threads.length };
            }),
          ).pipe(
            // A failed SQL check evicts nothing this sweep; residency is never guessed.
            Effect.catch((error) =>
              Effect.logWarning("read-model eviction skipped", { error }).pipe(
                Effect.as({ evicted: 0, resident: input.readModel().threads.length }),
              ),
            ),
            Effect.withSpan("OrchestrationEngine.evictIdleThreads"),
          );

  return {
    withThreadHistoryBarrier: (threadId, effect) =>
      barrier(
        // Hydration itself uses SQL transactions. Reserve interruptibly before
        // those masked acquisitions; release SQL before identity/dispatch preparation.
        withMetadataTransaction(input.workspaceSql, hydrator.load(threadId, "history")).pipe(
          Effect.orDie,
          Effect.andThen(effect),
        ),
      ),
    ensureThreadState: (threadId, level) =>
      barrier(hydrator.load(threadId, level)).pipe(Effect.orDie),
    getThread: (threadId, level) =>
      Effect.suspend(() => {
        const resident = hydrator.peek(threadId, level);
        return resident !== undefined
          ? Effect.succeed(resident)
          : barrier(hydrator.load(threadId, level)).pipe(Effect.orDie);
      }),
    ensureProjectState: (projectId) => barrier(hydrator.loadProject(projectId)).pipe(Effect.orDie),
    ensureWorkspaceProjects: (workspaceRoot) =>
      barrier(hydrator.loadWorkspaceProjects(workspaceRoot)).pipe(Effect.orDie),
    ensureProjectThreads: (projectId) =>
      barrier(
        hydrator
          .loadProjectWithThreads(projectId, "operational")
          .pipe(
            Effect.map(() => residentThreads().filter((thread) => thread.projectId === projectId)),
          ),
      ).pipe(Effect.orDie),
    ensureThreadSubtree: (rootThreadId) =>
      barrier(
        hydrator.loadThreadSubtree(rootThreadId, "operational").pipe(Effect.map(residentThreads)),
      ).pipe(Effect.orDie),
    listProjectThreadIds: (projectId) =>
      input.query.listProjectThreadIds(projectId).pipe(Effect.orDie),
    ...(evictIdleThreads ? { evictIdleThreads } : {}),
  };
}
