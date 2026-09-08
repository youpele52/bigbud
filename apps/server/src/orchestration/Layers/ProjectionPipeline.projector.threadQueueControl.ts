import type { OrchestrationEvent } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { ProjectionThreadRepositoryShape } from "../../persistence/Services/ProjectionThreads.ts";

export const projectThreadQueueControlEvent = Effect.fn("projectThreadQueueControlEvent")(
  function* (input: {
    readonly event: OrchestrationEvent;
    readonly repository: ProjectionThreadRepositoryShape;
  }) {
    const { event, repository } = input;
    if (
      event.type !== "thread.prompt-queued" &&
      event.type !== "thread.queued-prompt-removed" &&
      event.type !== "thread.queued-prompts-flushed" &&
      event.type !== "thread.turn-interrupt-requested" &&
      event.type !== "thread.turn-steer-requested" &&
      event.type !== "thread.session-stop-requested" &&
      event.type !== "thread.turn-control-set"
    )
      return false;
    const existing = yield* repository.getById({ threadId: event.payload.threadId });
    if (Option.isNone(existing)) return true;
    const row = existing.value;
    if (
      event.type === "thread.turn-interrupt-requested" ||
      event.type === "thread.turn-steer-requested" ||
      event.type === "thread.session-stop-requested"
    ) {
      yield* repository.upsert({
        ...row,
        ...(event.type === "thread.turn-interrupt-requested" && event.payload.pendingFlushIntent
          ? { pendingInterruptFlushIntent: event.payload.pendingFlushIntent }
          : {}),
        ...(event.payload.operation
          ? { pendingTurnControlOperation: event.payload.operation }
          : {}),
        ...(event.type === "thread.session-stop-requested" ? { queueHold: true } : {}),
        updatedAt: event.occurredAt,
      });
      return true;
    }
    if (event.type === "thread.turn-control-set") {
      yield* repository.upsert({
        ...row,
        pendingTurnControlOperation: event.payload.operation,
        updatedAt: event.occurredAt,
      });
      return true;
    }
    const queuedPrompts =
      event.type === "thread.prompt-queued"
        ? row.queuedPrompts.some((prompt) => prompt.id === event.payload.prompt.id)
          ? row.queuedPrompts
          : [...row.queuedPrompts, event.payload.prompt]
        : event.type === "thread.queued-prompt-removed"
          ? row.queuedPrompts.filter((prompt) => prompt.id !== event.payload.messageId)
          : row.queuedPrompts.filter((prompt) => !event.payload.messageIds.includes(prompt.id));
    yield* repository.upsert({
      ...row,
      queuedPrompts,
      ...(event.type === "thread.queued-prompts-flushed" ? { queueHold: false } : {}),
      pendingInterruptFlushIntent:
        event.type === "thread.queued-prompt-removed" &&
        row.pendingInterruptFlushIntent?.queuedPromptIds.includes(event.payload.messageId)
          ? null
          : event.type === "thread.queued-prompts-flushed" &&
              row.pendingInterruptFlushIntent?.queuedPromptIds.length ===
                event.payload.messageIds.length &&
              row.pendingInterruptFlushIntent.queuedPromptIds.every(
                (id, index) => id === event.payload.messageIds[index],
              )
            ? null
            : row.pendingInterruptFlushIntent,
      updatedAt: event.occurredAt,
    });
    return true;
  },
);
