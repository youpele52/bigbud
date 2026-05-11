import { type OrchestrationProject, type OrchestrationThread, ProjectId } from "@bigbud/contracts";
import { Duration, Effect } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";

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
const PROJECT_DELETE_POLL_INTERVAL = Duration.millis(100);

export const makeProcessProjectDeletionRequested = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;

  const waitForProjectThreadsToSettle = Effect.fn("waitForProjectThreadsToSettle")(function* (
    deps: ProjectDeletionDeps,
    projectId: ProjectId,
  ): Effect.fn.Return<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
    const startedAt = Date.now();

    while (true) {
      const threads = yield* deps.resolveThreadsByProject(projectId);
      const activeThreads = threads.filter((thread) => thread.deletedAt === null);

      if (activeThreads.length === 0) {
        return { ok: true } as const;
      }

      const failedThread = activeThreads.find(
        (thread) => thread.deletingAt === null || thread.deletingAt === undefined,
      );
      if (failedThread) {
        return {
          ok: false,
          detail: `Thread '${failedThread.id}' deletion failed while deleting project '${projectId}'.`,
        } as const;
      }

      if (Date.now() - startedAt >= Duration.toMillis(PROJECT_DELETE_TIMEOUT)) {
        return {
          ok: false,
          detail: `Timed out waiting for threads in project '${projectId}' to delete.`,
        } as const;
      }

      yield* Effect.sleep(PROJECT_DELETE_POLL_INTERVAL);
    }
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

    yield* orchestrationEngine.dispatch({
      type: "project.delete.finalize",
      commandId: serverCommandId("project-delete-finalize"),
      projectId: event.payload.projectId,
      createdAt,
    });
  });
});
