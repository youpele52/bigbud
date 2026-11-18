import { Effect, Option } from "effect";
import {
  ServerRestartRemoteAgentError,
  type ServerRestartRemoteAgentInput,
  type ServerRestartRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteRestart.ts";

import type { RemoteAgentRestartServiceShape } from "../remote-agent/remoteAgentRestart.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionProjectRepositoryShape } from "../persistence/Services/ProjectionProjects.ts";

/** Where restart admission reads the project's workspace target from. */
export interface RemoteAgentRestartProjectSources {
  readonly orchestrationEngine?: OrchestrationEngineShape;
  readonly projectionProjectRepository?: Option.Option<ProjectionProjectRepositoryShape>;
}

/** Resolves the project's current workspace target; `null` = project unknown, `undefined` = no source. */
const projectWorkspaceTarget = Effect.fn("remoteAgentRestart.projectWorkspaceTarget")(function* (
  input: ServerRestartRemoteAgentInput,
  sources: RemoteAgentRestartProjectSources,
): Effect.fn.Return<string | null | undefined, ServerRestartRemoteAgentError> {
  const projects = Option.getOrUndefined(sources.projectionProjectRepository ?? Option.none());
  if (projects) {
    // The durable projection row, not the in-memory read model: after a backend restart the
    // read model holds only projects with operational threads, while a durable restart request
    // must stay queryable and retryable for any project that still references the target.
    const row = yield* projects.getById({ projectId: input.projectId }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerRestartRemoteAgentError({
            message: "The project could not be read for the remote service restart.",
            cause,
          }),
      ),
    );
    return Option.isSome(row) ? row.value.workspaceExecutionTargetId : null;
  }
  if (!sources.orchestrationEngine) return undefined;
  const model = yield* sources.orchestrationEngine.getReadModel();
  return (
    model.projects.find((entry) => entry.id === input.projectId)?.workspaceExecutionTargetId ?? null
  );
});

const assertProjectReferencesTarget = Effect.fn("remoteAgentRestart.assertProjectReferencesTarget")(
  function* (input: ServerRestartRemoteAgentInput, sources: RemoteAgentRestartProjectSources) {
    const target = yield* projectWorkspaceTarget(input, sources);
    if (target !== undefined && target !== input.expectedWorkspaceExecutionTargetId)
      return yield* new ServerRestartRemoteAgentError({
        message: "The project no longer references the selected remote service.",
      });
  },
);

export const restartRemoteAgentEffect = Effect.fn("restartRemoteAgentEffect")(function* (
  input: ServerRestartRemoteAgentInput,
  restart: RemoteAgentRestartServiceShape | undefined,
  sources: RemoteAgentRestartProjectSources = {},
): Effect.fn.Return<ServerRestartRemoteAgentResult, ServerRestartRemoteAgentError> {
  if (!restart) {
    return yield* new ServerRestartRemoteAgentError({
      message: "Remote service restart is unavailable in this server configuration.",
    });
  }
  yield* assertProjectReferencesTarget(input, sources);
  return yield* Effect.tryPromise({
    try: () => restart.restart(input),
    catch: (cause) =>
      new ServerRestartRemoteAgentError({
        message: cause instanceof Error ? cause.message : "Remote service restart failed.",
        cause,
      }),
  });
});

export const getRemoteAgentRestartStatusEffect = Effect.fn("getRemoteAgentRestartStatusEffect")(
  function* (
    input: ServerRestartRemoteAgentInput,
    restart: RemoteAgentRestartServiceShape | undefined,
    sources: RemoteAgentRestartProjectSources = {},
  ): Effect.fn.Return<ServerRestartRemoteAgentResult, ServerRestartRemoteAgentError> {
    if (!restart)
      return yield* new ServerRestartRemoteAgentError({
        message: "Remote service restart is unavailable in this server configuration.",
      });
    yield* assertProjectReferencesTarget(input, sources);
    return yield* Effect.tryPromise({
      try: () => restart.status(input),
      catch: (cause) =>
        new ServerRestartRemoteAgentError({
          message: cause instanceof Error ? cause.message : "Remote restart status unavailable.",
          cause,
        }),
    });
  },
);
