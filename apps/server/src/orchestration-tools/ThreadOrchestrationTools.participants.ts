import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import {
  ensureOrchestrationThreadState,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import { requireThreadCoordinationAccess } from "./ThreadOrchestrationTools.access.ts";

/** Startup is intentionally sparse. Resolve only the two exact durable participants,
 * then authorize the authenticated caller; hydration never makes a target the caller. */
export const resolveThreadToolParticipants = Effect.fn("resolveThreadToolParticipants")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly threadDelegationRepository: ThreadDelegationRepositoryShape;
    readonly callerThreadId: ThreadId;
    readonly threadId: ThreadId;
    readonly operation: "send" | "status" | "rename";
  }) {
    const callerThread = yield* ensureOrchestrationThreadState(
      input.orchestrationEngine,
      input.callerThreadId,
      "operational",
    );
    if (!callerThread || callerThread.deletedAt !== null)
      return yield* Effect.fail(
        new Error(
          input.operation === "rename"
            ? "Caller thread was not found."
            : "Caller thread could not be resolved.",
        ),
      );
    if (callerThread.deletingAt)
      return yield* Effect.fail(new Error("Caller thread is being deleted."));
    const targetThread =
      input.threadId === input.callerThreadId
        ? callerThread
        : yield* ensureOrchestrationThreadState(
            input.orchestrationEngine,
            input.threadId,
            "operational",
          );
    if (!targetThread || targetThread.deletedAt !== null)
      return yield* Effect.fail(new Error(`Thread '${input.threadId}' was not found.`));
    if (targetThread.deletingAt)
      return yield* Effect.fail(
        new Error(
          `Thread '${input.threadId}' is ${input.operation === "send" ? "not available" : "being deleted"}.`,
        ),
      );
    yield* requireThreadCoordinationAccess({
      threadDelegationRepository: input.threadDelegationRepository,
      callerThread,
      targetThread,
    });
    return { callerThread, targetThread };
  },
);
