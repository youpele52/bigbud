import { type OrchestrationProject, type OrchestrationThread, ProjectId } from "@bigbud/contracts";
import { Duration, Effect } from "effect";

import {
  cleanupDiscoveredProjectDeletionFiles,
  discoverProjectDeletionFiles,
} from "../../deletion/Layers/ProjectDeletion.files.ts";
import { ServerConfig } from "../../startup/config.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";
import { waitForReadModelCondition, type ReadModelSettleCheck } from "./readModelSettle.ts";

type ProjectDeletionRequestedEvent = Extract<
  import("@bigbud/contracts").OrchestrationEvent,
  { type: "project.deletion-requested" }
>;

interface ProjectDeletionDeps {
  readonly resolveProject: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProject | undefined>;
  readonly resolveThreadsByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThread>>;
}

const PROJECT_DELETE_TIMEOUT = Duration.seconds(30);

type ProjectThreadSettleResult =
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

export const makeProcessProjectDeletionRequested = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const config = yield* ServerConfig;
  const waitForProjectThreadsToSettle = Effect.fn("waitForProjectThreadsToSettle")(function* (
    deps: ProjectDeletionDeps,
    projectId: ProjectId,
  ): Effect.fn.Return<ProjectThreadSettleResult> {
    const evaluate = deps
      .resolveThreadsByProject(projectId)
      .pipe(Effect.map((threads) => evaluateProjectThreadSettle(threads, projectId)));
    return yield* waitForReadModelCondition({
      check: evaluate,
      events: orchestrationEngine.streamDomainEvents,
      timeout: PROJECT_DELETE_TIMEOUT,
      onTimeout: {
        ok: false as const,
        detail: `Timed out waiting for threads in project '${projectId}' to delete.`,
      },
    });
  });

  return Effect.fn("processProjectDeletionRequested")(function* (
    deps: ProjectDeletionDeps,
    event: ProjectDeletionRequestedEvent,
  ): Effect.fn.Return<void, OrchestrationDispatchError> {
    const project = yield* deps.resolveProject(event.payload.projectId);
    if (!project || project.deletedAt !== null) {
      return;
    }

    const result = yield* waitForProjectThreadsToSettle(deps, event.payload.projectId);
    const createdAt = new Date().toISOString();

    if (!result.ok) {
      yield* Effect.logWarning("project deletion aborted", {
        projectId: event.payload.projectId,
        detail: result.detail,
      });
      yield* orchestrationEngine.dispatch({
        type: "project.delete.abort",
        commandId: serverCommandId("project-delete-abort"),
        projectId: event.payload.projectId,
        createdAt,
      });
      return;
    }

    const files = yield* discoverProjectDeletionFiles(event.payload.projectId).pipe(
      Effect.provideService(ServerConfig, config),
      Effect.catch((error) =>
        Effect.logWarning("project deletion resource capture failed", {
          projectId: event.payload.projectId,
          detail: String(error),
        }).pipe(Effect.as(undefined)),
      ),
    );
    if (files === undefined) {
      yield* orchestrationEngine.dispatch({
        type: "project.delete.abort",
        commandId: serverCommandId("project-delete-abort"),
        projectId: event.payload.projectId,
        createdAt,
      });
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "project.delete.finalize",
      commandId: serverCommandId("project-delete-finalize"),
      projectId: event.payload.projectId,
      createdAt,
    });
    const orphanedResources = yield* cleanupDiscoveredProjectDeletionFiles(files).pipe(
      Effect.provideService(ServerConfig, config),
    );
    if (orphanedResources.length > 0) {
      yield* Effect.logWarning("project deletion orphan resource cleanup required", {
        projectId: event.payload.projectId,
        orphanedResources,
      });
    }
  });
});
