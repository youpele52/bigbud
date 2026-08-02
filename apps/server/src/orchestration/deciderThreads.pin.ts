import {
  FAVORITE_THREAD_LIMIT,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { requireThread } from "./commandInvariants.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { nowIso, withEventBase } from "./deciderHelpers.ts";

export type ThreadPinCommand = Extract<
  OrchestrationCommand,
  { type: "thread.pin" | "thread.unpin" | "thread.pin.migrate" }
>;

export const decideThreadPinCommand = Effect.fn("decideThreadPinCommand")(function* (input: {
  readonly command: ThreadPinCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  const { command, readModel } = input;
  const thread = yield* requireThread({ readModel, command, threadId: command.threadId });

  if (command.type === "thread.unpin") {
    if ((thread.pinnedAt ?? null) === null) return [];
    const occurredAt = nowIso();
    return {
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt,
        commandId: command.commandId,
      }),
      type: "thread.unpinned",
      payload: { threadId: command.threadId, updatedAt: occurredAt },
    };
  }

  if (command.type === "thread.pin.migrate") {
    if (thread.deletedAt !== null || (thread.deletingAt ?? null) !== null) return [];
    if ((thread.pinnedAt ?? null) !== null) return [];
    const pinnedCount = readModel.threads.filter(
      (entry) => entry.deletedAt === null && (entry.pinnedAt ?? null) !== null,
    ).length;
    if (pinnedCount >= FAVORITE_THREAD_LIMIT) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: `You can pin up to ${FAVORITE_THREAD_LIMIT} threads.`,
      });
    }
    return {
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt: command.pinnedAt,
        commandId: command.commandId,
      }),
      type: "thread.pinned",
      payload: {
        threadId: command.threadId,
        pinnedAt: command.pinnedAt,
        updatedAt: command.pinnedAt,
      },
    };
  }

  if (thread.deletedAt !== null || (thread.deletingAt ?? null) !== null) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Thread '${command.threadId}' cannot be pinned while deleted or pending deletion.`,
    });
  }
  if (thread.archivedAt !== null) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Archived thread '${command.threadId}' cannot be pinned.`,
    });
  }
  if ((thread.pinnedAt ?? null) !== null) return [];
  const pinnedCount = readModel.threads.filter(
    (entry) => entry.deletedAt === null && (entry.pinnedAt ?? null) !== null,
  ).length;
  if (pinnedCount >= FAVORITE_THREAD_LIMIT) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `You can pin up to ${FAVORITE_THREAD_LIMIT} threads.`,
    });
  }
  const occurredAt = nowIso();
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt,
      commandId: command.commandId,
    }),
    type: "thread.pinned",
    payload: { threadId: command.threadId, pinnedAt: occurredAt, updatedAt: occurredAt },
  };
});
