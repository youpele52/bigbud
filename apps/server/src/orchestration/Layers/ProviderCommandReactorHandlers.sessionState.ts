import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationSession } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "../Errors.ts";
import {
  ensureOrchestrationThreadState,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";

export function makeProviderCommandSessionStateHelpers(
  orchestrationEngine: OrchestrationEngineShape,
) {
  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
    readonly expectedSessionEpoch?: number;
    readonly expectedActiveTurnId?: import("@bigbud/contracts").TurnId;
    readonly advanceSessionEpoch?: boolean;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.session.set",
        commandId: serverCommandId("provider-session-set"),
        threadId: input.threadId,
        session: input.session,
        ...(input.expectedSessionEpoch !== undefined
          ? { expectedSessionEpoch: input.expectedSessionEpoch }
          : {}),
        ...(input.expectedActiveTurnId !== undefined
          ? { expectedActiveTurnId: input.expectedActiveTurnId }
          : {}),
        ...(input.advanceSessionEpoch ? { advanceSessionEpoch: true } : {}),
        createdAt: input.createdAt,
      })
      .pipe(Effect.asVoid);

  const resolveThread = Effect.fn("resolveThread")(function* (threadId: ThreadId) {
    return yield* ensureOrchestrationThreadState(orchestrationEngine, threadId, "history");
  });

  const assertRuntimeStartAllowed = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      if (yield* orchestrationEngine.threadDeletion!.isFenced({ threadId, readModel })) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: "thread.session.start",
          detail: `Thread '${threadId}' or an ancestor is being deleted.`,
        });
      }
    });

  return { assertRuntimeStartAllowed, resolveThread, setThreadSession };
}
