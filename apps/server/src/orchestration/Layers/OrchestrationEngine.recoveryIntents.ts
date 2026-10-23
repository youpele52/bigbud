/**
 * Durable recovery-intent writes that must commit atomically with the orchestration event.
 *
 * Runs inside the command transaction, right after each event is appended and projected:
 *
 * - `thread.turn-start-requested` records an `active` intent for the message and settles the
 *   thread's older intents, except the one this message continues.
 * - A user Stop (`thread.turn-interrupt-requested`, `thread.session-stop-requested`) revokes
 *   every unfinished intent of the thread, so it is never resumed. So does deleting it.
 * - A prompt the user queues settles intents that are in recovery: user activity wins.
 * - A sleep recovery continuation (`thread.turn.start` with a `sleepRecovery` origin) commits
 *   only while its original intent is still `active` and `continuing` with this message as
 *   its continuation. Otherwise the whole command is refused, so a continuation can never
 *   start after the user's own message or a Stop that landed after the coordinator decided.
 *
 * Without the repository (tests, older composition) nothing is written.
 *
 * @module OrchestrationEngine.recoveryIntents
 */
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Effect, Option } from "effect";

import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ThreadRecoveryIntentRepository,
  type ThreadRecoveryIntentKey,
  type ThreadRecoveryIntentRepositoryShape,
} from "../../persistence/Services/ThreadRecoveryIntents.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { hasSleepRecoveryOrigin } from "../ThreadMessageOrigin.logic.ts";

export type RecoveryIntentRecorder = (
  event: OrchestrationEvent,
  command?: OrchestrationCommand,
) => Effect.Effect<void, PersistenceSqlError | OrchestrationCommandInvariantError>;

/** Refuses a continuation whose original intent is no longer waiting for it. */
const requireContinuationStillWanted = Effect.fn("requireContinuationStillWanted")(function* (
  repository: ThreadRecoveryIntentRepositoryShape,
  key: ThreadRecoveryIntentKey,
) {
  const own = yield* repository.get(key);
  const originalId = Option.getOrUndefined(own)?.detail.continuationOf;
  const original =
    originalId === undefined
      ? Option.none()
      : yield* repository.get({ threadId: key.threadId, messageId: originalId });
  const wanted =
    Option.isSome(original) &&
    original.value.disposition === "active" &&
    original.value.recoveryStatus === "continuing" &&
    original.value.continuationMessageId === key.messageId;
  if (wanted) return;
  return yield* new OrchestrationCommandInvariantError({
    commandType: "thread.turn.start",
    detail: "This sleep recovery continuation is no longer wanted; the thread moved on.",
    code: "prompt_not_queueable",
  });
});

const recordTurnStart = (
  repository: ThreadRecoveryIntentRepositoryShape,
  event: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>,
  command: OrchestrationCommand | undefined,
) => {
  const { threadId, messageId } = event.payload;
  // Only a direct start is fenced: refusing a queue flush would wedge the queue.
  const fence =
    command?.type === "thread.turn.start" && hasSleepRecoveryOrigin(command.message)
      ? requireContinuationStillWanted(repository, { threadId, messageId })
      : Effect.void;
  return fence.pipe(
    Effect.andThen(
      repository.settleSupersededByTurnStart({ threadId, messageId, at: event.occurredAt }),
    ),
    Effect.andThen(
      repository.recordAccepted({
        threadId,
        messageId,
        provider: event.payload.modelSelection?.provider ?? null,
        createdAt: event.occurredAt,
      }),
    ),
  );
};

export function recordRecoveryIntentForEvent(
  repository: ThreadRecoveryIntentRepositoryShape,
  event: OrchestrationEvent,
  command?: OrchestrationCommand,
): Effect.Effect<void, PersistenceSqlError | OrchestrationCommandInvariantError> {
  switch (event.type) {
    case "thread.turn-start-requested":
      return recordTurnStart(repository, event, command);
    case "thread.turn-interrupt-requested":
    case "thread.session-stop-requested":
      return repository.revokeForThread({ threadId: event.payload.threadId, at: event.occurredAt });
    case "thread.deleted":
      return Effect.forEach(
        new Set([event.payload.threadId, ...(event.payload.threadIds ?? [])]),
        (threadId) => repository.revokeForThread({ threadId, at: event.occurredAt }),
        { discard: true },
      );
    case "thread.prompt-queued":
      // A busy refusal re-queues an already-sent message; that is not new user activity.
      if (event.payload.prompt.alreadySent === true) return Effect.void;
      return repository.settleRecoveringForThread({
        threadId: event.payload.threadId,
        at: event.occurredAt,
      });
    default:
      return Effect.void;
  }
}

export const makeRecoveryIntentRecorder: Effect.Effect<RecoveryIntentRecorder> = Effect.gen(
  function* () {
    const repository = yield* Effect.serviceOption(ThreadRecoveryIntentRepository);
    return Option.isNone(repository)
      ? () => Effect.void
      : (event, command) => recordRecoveryIntentForEvent(repository.value, event, command);
  },
);
