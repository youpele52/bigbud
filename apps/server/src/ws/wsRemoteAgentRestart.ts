import { Effect } from "effect";
import {
  ServerRestartRemoteAgentError,
  type ServerRestartRemoteAgentInput,
  type ServerRestartRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteRestart.ts";

import type { RemoteAgentRestartServiceShape } from "../remote-agent/remoteAgentRestart.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

export const restartRemoteAgentEffect = Effect.fn("restartRemoteAgentEffect")(function* (
  input: ServerRestartRemoteAgentInput,
  restart: RemoteAgentRestartServiceShape | undefined,
  orchestrationEngine?: OrchestrationEngineShape,
): Effect.fn.Return<ServerRestartRemoteAgentResult, ServerRestartRemoteAgentError> {
  if (!restart) {
    return yield* new ServerRestartRemoteAgentError({
      message: "Remote service restart is unavailable in this server configuration.",
    });
  }
  if (orchestrationEngine) {
    const project = yield* orchestrationEngine
      .getReadModel()
      .pipe(Effect.map((model) => model.projects.find((entry) => entry.id === input.projectId)));
    if (
      !project ||
      project.workspaceExecutionTargetId !== input.expectedWorkspaceExecutionTargetId
    ) {
      return yield* new ServerRestartRemoteAgentError({
        message: "The project no longer references the selected remote service.",
      });
    }
  }
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
    orchestrationEngine?: OrchestrationEngineShape,
  ): Effect.fn.Return<ServerRestartRemoteAgentResult, ServerRestartRemoteAgentError> {
    if (!restart)
      return yield* new ServerRestartRemoteAgentError({
        message: "Remote service restart is unavailable in this server configuration.",
      });
    if (orchestrationEngine) {
      const project = yield* orchestrationEngine
        .getReadModel()
        .pipe(Effect.map((model) => model.projects.find((entry) => entry.id === input.projectId)));
      if (
        !project ||
        project.workspaceExecutionTargetId !== input.expectedWorkspaceExecutionTargetId
      )
        return yield* new ServerRestartRemoteAgentError({
          message: "The project no longer references the selected remote service.",
        });
    }
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
