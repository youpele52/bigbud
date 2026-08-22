import type { OrchestrationThread } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";

export const requireThreadCoordinationAccess = Effect.fn("requireThreadCoordinationAccess")(
  function* (input: {
    readonly threadDelegationRepository: ThreadDelegationRepositoryShape;
    readonly callerThread: OrchestrationThread;
    readonly targetThread: OrchestrationThread;
  }) {
    if (input.callerThread.projectId === input.targetThread.projectId) return;

    const delegation = yield* input.threadDelegationRepository
      .findDirectByChild({ childThreadId: input.targetThread.id })
      .pipe(
        Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
      );
    if (Option.isSome(delegation) && delegation.value.callerThreadId === input.callerThread.id) {
      return;
    }

    return yield* Effect.fail(
      new Error(`Thread '${input.targetThread.id}' is not accessible from the current project.`),
    );
  },
);
