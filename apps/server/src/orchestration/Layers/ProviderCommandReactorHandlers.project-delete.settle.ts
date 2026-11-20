/**
 * The project-delete handler's wait for the project's cascaded thread deletions to finish.
 *
 * @module ProviderCommandReactorHandlers.project-delete.settle
 */
import type { OrchestrationEvent, OrchestrationThread, ProjectId } from "@bigbud/contracts";
import { Duration, Effect, type Stream } from "effect";

import { waitForReadModelCondition, type ReadModelSettleCheck } from "./readModelSettle.ts";

export const PROJECT_DELETE_TIMEOUT = Duration.seconds(30);

export type ProjectThreadSettleResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

function isActiveInDeletingSubtree(
  thread: OrchestrationThread,
  threadsById: ReadonlyMap<OrchestrationThread["id"], OrchestrationThread>,
): boolean {
  let current: OrchestrationThread | undefined = thread;
  const seen = new Set<OrchestrationThread["id"]>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.deletedAt !== null) return false;
    if (current.deletingAt != null) return true;
    const parentId: OrchestrationThread["id"] | undefined = current.parentThread?.threadId;
    current = parentId ? threadsById.get(parentId) : undefined;
  }
  return false;
}

export function evaluateProjectThreadSettle(
  threads: ReadonlyArray<OrchestrationThread>,
  projectId: ProjectId,
): ReadModelSettleCheck<ProjectThreadSettleResult> {
  const activeThreads = threads.filter((thread) => thread.deletedAt === null);
  if (activeThreads.length === 0) {
    return { done: true, value: { ok: true } };
  }
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const stranded = activeThreads.find((thread) => !isActiveInDeletingSubtree(thread, threadsById));
  if (stranded) {
    return {
      done: true,
      value: {
        ok: false,
        detail: `Thread '${stranded.id}' deletion failed while deleting project '${projectId}'.`,
      },
    };
  }
  return { done: false };
}

export const waitForProjectThreadsToSettle = Effect.fn("waitForProjectThreadsToSettle")(
  function* (input: {
    readonly projectId: ProjectId;
    readonly resolveThreadsByProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<OrchestrationThread>>;
    readonly events: Stream.Stream<OrchestrationEvent>;
    readonly timeout?: Duration.Duration;
    readonly recheckInterval?: Duration.Duration;
  }): Effect.fn.Return<ProjectThreadSettleResult> {
    return yield* waitForReadModelCondition({
      check: input
        .resolveThreadsByProject(input.projectId)
        .pipe(Effect.map((threads) => evaluateProjectThreadSettle(threads, input.projectId))),
      events: input.events,
      timeout: input.timeout ?? PROJECT_DELETE_TIMEOUT,
      ...(input.recheckInterval ? { recheckInterval: input.recheckInterval } : {}),
      onTimeout: {
        ok: false as const,
        detail: `Timed out waiting for threads in project '${input.projectId}' to delete.`,
      },
    });
  },
);
