import type { OrchestrationCommand, OrchestrationReadModel } from "@bigbud/contracts";
import { Deferred, Effect } from "effect";
import type { BoundedCommandAdmission } from "../../command-admission/CommandAdmission.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { makeLifecycleQueuedPromptFlushCommand } from "../QueuedPromptFlush.logic.ts";
import { calculateCommandPayloadDigest } from "../commandDigest.ts";
import type { CommandEnvelope } from "./OrchestrationEngine.commandEnvelope.ts";

export const enqueueLifecycleFlush = Effect.fn("OrchestrationEngine.enqueueLifecycleFlush")(
  function* (
    admission: BoundedCommandAdmission<CommandEnvelope>,
    trigger: OrchestrationCommand,
    readModel: OrchestrationReadModel,
  ) {
    const command = makeLifecycleQueuedPromptFlushCommand({
      trigger,
      readModel,
      createdAt: new Date().toISOString(),
    });
    if (!command) return;
    const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
    yield* admission
      .offer(
        {
          command,
          result,
          startedAtMs: Date.now(),
          payloadDigest: calculateCommandPayloadDigest(command),
        },
        "internal",
      )
      .pipe(
        Effect.catchTag("CommandAdmissionError", (error) =>
          Effect.logError("failed to enqueue lifecycle command", {
            queue: error.queue,
            code: error.code,
          }),
        ),
      );
  },
);
