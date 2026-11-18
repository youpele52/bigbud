import type { OrchestrationCommand, OrchestrationReadModel } from "@bigbud/contracts";
import { Deferred, Effect } from "effect";
import type { BoundedCommandAdmission } from "../../command-admission/CommandAdmission.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { makeWorktreeReservations } from "../../git/Layers/WorktreeReservations.ts";
import {
  makeLifecycleQueuedPromptFlushCommand,
  makeQueuedPromptFlushCommand,
} from "../QueuedPromptFlush.logic.ts";
import { calculateCommandPayloadDigest } from "../commandDigest.ts";
import type { CommandEnvelope } from "./OrchestrationEngine.commandEnvelope.ts";

export const enqueueLifecycleFlush = Effect.fn("OrchestrationEngine.enqueueLifecycleFlush")(
  function* (
    admission: BoundedCommandAdmission<CommandEnvelope>,
    trigger: OrchestrationCommand,
    readModel: OrchestrationReadModel,
    /** True while a runtime update holds admission: queued prompts stay durable (WP-4D). */
    held?: () => boolean,
  ) {
    if (held?.()) return;
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

/**
 * Startup (and post-maintenance reopen) flush of one thread's durable queued prompts. A runtime
 * update holds it while admission is closed so a trial runtime never starts provider work.
 */
export const enqueueQueuedPromptRecovery = Effect.fn(
  "OrchestrationEngine.enqueueQueuedPromptRecovery",
)(function* (input: {
  readonly admission: BoundedCommandAdmission<CommandEnvelope>;
  readonly readModel: OrchestrationReadModel;
  readonly threadId: OrchestrationReadModel["threads"][number]["id"];
  readonly worktreeReservations: ReturnType<typeof makeWorktreeReservations>;
}) {
  const command = makeQueuedPromptFlushCommand({
    threadId: input.threadId,
    readModel: input.readModel,
    createdAt: new Date().toISOString(),
  });
  if (!command) return;
  const allowed = yield* input.worktreeReservations.assertAllows(command).pipe(Effect.result);
  if (allowed._tag !== "Success") return;
  const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
  yield* input.admission.offer(
    {
      command,
      payloadDigest: calculateCommandPayloadDigest(command),
      result,
      startedAtMs: Date.now(),
    },
    "internal",
  );
});
