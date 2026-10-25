/**
 * Decider for `thread.fork`: continue a thread in a new server-side thread with bounded settled
 * history, explicit lineage, and the pending message sent only when it was never admitted.
 *
 * @module deciderThreads.fork
 */
import {
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import {
  THREAD_FORK_ORIGIN_ACTIVITY_KIND,
  THREAD_FORKED_ACTIVITY_KIND,
  type ThreadForkCommand,
  type ThreadForkOrigin,
} from "@bigbud/contracts/orchestration/orchestration.fork.ts";
import {
  isLegacyOpencodeThread,
  LEGACY_OPENCODE_READ_ONLY_MESSAGE,
} from "@bigbud/shared/providerLifecycle";
import { Effect } from "effect";

import {
  requireProjectNotDeleting,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";
import { decideForkPendingCarry, findCarryTargetFork } from "./deciderThreads.fork.carry.ts";
import { requireThreadReadyForMutation } from "./deciderThreads.turn.start.ts";
import {
  copyForkActivities,
  copyForkMessages,
  copyForkPlans,
  copyForkTasks,
  forkEntityId,
  isForkAlreadyRecorded,
  resolvePendingDelivery,
  selectForkMessages,
  wasPendingDeliveredBefore,
} from "./deciderThreads.fork.logic.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

type DecidedEvent = Omit<OrchestrationEvent, "sequence">;

export const decideThreadForkCommand = Effect.fn("decideThreadForkCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: ThreadForkCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<ReadonlyArray<DecidedEvent>, OrchestrationCommandInvariantError> {
  const source = yield* requireThread({ readModel, command, threadId: command.sourceThreadId });
  const carryTarget = findCarryTargetFork({ readModel, source, command });
  if (carryTarget !== undefined) {
    return yield* decideForkPendingCarry({ command, readModel, source, fork: carryTarget });
  }
  if (isForkAlreadyRecorded({ readModel, source, command })) return [];
  yield* requireThreadReadyForMutation({ thread: source, command });
  yield* requireProjectNotDeleting({ readModel, command, projectId: source.projectId });
  yield* requireThreadAbsent({ readModel, command, threadId: command.threadId });
  if (isLegacyOpencodeThread(source)) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: LEGACY_OPENCODE_READ_ONLY_MESSAGE,
    });
  }
  const modelSelection = command.modelSelection ?? source.modelSelection;
  // Automatic forks keep the provider (D18); only the user's explicit manual choice may switch.
  if (command.reason !== "manual" && modelSelection.provider !== source.modelSelection.provider) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `An automatic fork keeps the source provider '${source.modelSelection.provider}'; switching provider to '${modelSelection.provider}' is not allowed.`,
    });
  }

  const forkId = command.threadId;
  const event = (type: DecidedEvent["type"], payload: unknown, aggregateId = forkId) =>
    ({
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      }),
      type,
      payload,
    }) as DecidedEvent;

  const pending =
    command.pendingMessageId === undefined
      ? undefined
      : source.messages.find((message) => message.id === command.pendingMessageId);
  const pendingDelivery = pending ? resolvePendingDelivery(source, pending) : undefined;
  const settled = selectForkMessages(source, command.pendingMessageId);
  const messages = copyForkMessages(forkId, settled);
  const forkOrigin: ThreadForkOrigin = {
    // The last settled source message the fork continues from.
    forkPointMessageId: settled.at(-1)?.id ?? null,
    reason: command.reason,
    failureEventId: command.failureEventId ?? null,
    ...(pendingDelivery !== undefined ? { pendingDelivery } : {}),
  };
  const lineage = {
    reason: command.reason,
    failureEventId: command.failureEventId ?? null,
    forkPointMessageId: forkOrigin.forkPointMessageId,
    pendingDelivery: pendingDelivery ?? null,
    ...(pendingDelivery === "sent" && pending && wasPendingDeliveredBefore(source, pending.id)
      ? { redelivered: true }
      : {}),
  };

  const events: DecidedEvent[] = [
    event("thread.created", {
      threadId: forkId,
      projectId: source.projectId,
      title: source.title,
      purpose: source.purpose ?? "standard",
      ...(source.providerRuntimeExecutionTargetId !== undefined
        ? { providerRuntimeExecutionTargetId: source.providerRuntimeExecutionTargetId }
        : {}),
      ...(source.workspaceExecutionTargetId !== undefined
        ? { workspaceExecutionTargetId: source.workspaceExecutionTargetId }
        : {}),
      ...(source.executionTargetId !== undefined
        ? { executionTargetId: source.executionTargetId }
        : {}),
      modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: source.interactionMode,
      branch: source.branch,
      worktreePath: source.worktreePath,
      parentThread: { threadId: source.id, title: source.title, projectId: source.projectId },
      forkOrigin,
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    }),
    ...messages.map((message) =>
      event("thread.message-sent", {
        threadId: forkId,
        messageId: message.id,
        role: message.role,
        text: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
        ...(message.originSegments !== undefined ? { originSegments: message.originSegments } : {}),
        turnId: null,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      }),
    ),
    ...copyForkActivities(forkId, source, command.pendingMessageId).map((activity) =>
      event("thread.activity-appended", { threadId: forkId, activity }),
    ),
    ...copyForkPlans(forkId, source).map((proposedPlan) =>
      event("thread.proposed-plan-upserted", { threadId: forkId, proposedPlan }),
    ),
    ...copyForkTasks(forkId, source).map((task) =>
      event("thread.task-upserted", { threadId: forkId, task }),
    ),
    event("thread.activity-appended", {
      threadId: forkId,
      activity: {
        id: EventId.makeUnsafe(forkEntityId("activity", forkId, THREAD_FORK_ORIGIN_ACTIVITY_KIND)),
        tone: "info",
        kind: THREAD_FORK_ORIGIN_ACTIVITY_KIND,
        summary: `Continued from ${source.title}`,
        payload: { sourceThreadId: source.id, sourceTitle: source.title, ...lineage },
        turnId: null,
        createdAt: command.createdAt,
      },
    }),
  ];

  if (pending !== undefined) {
    const messageId = MessageId.makeUnsafe(forkEntityId("message", forkId, pending.id));
    const attachments = pending.attachments ?? [];
    if (pendingDelivery === "sent") {
      const sent = event("thread.message-sent", {
        threadId: forkId,
        messageId,
        role: "user",
        text: pending.text,
        attachments,
        turnId: null,
        streaming: false,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      });
      events.push(sent, {
        ...event("thread.turn-start-requested", {
          threadId: forkId,
          messageId,
          modelSelection,
          runtimeMode: source.runtimeMode,
          interactionMode: source.interactionMode,
          createdAt: command.createdAt,
        }),
        causationEventId: sent.eventId,
      });
    } else {
      // Uncertain admission: the fork's queue starts held, so nothing is sent without the user.
      events.push(
        event("thread.prompt-queued", {
          threadId: forkId,
          prompt: {
            id: messageId,
            text: pending.text.trim(),
            createdAt: command.createdAt,
            // No model or modes are pinned: the fork stays unlocked, and on release the message
            // uses whatever the user picked in the fork's composer (it starts as the source's).
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          queuePosition: 1,
        }),
      );
    }
  }

  events.push(
    event(
      "thread.activity-appended",
      {
        threadId: source.id,
        activity: {
          id: EventId.makeUnsafe(forkEntityId("activity", forkId, THREAD_FORKED_ACTIVITY_KIND)),
          tone: "info",
          kind: THREAD_FORKED_ACTIVITY_KIND,
          summary: "Continued in a new thread",
          payload: {
            forkThreadId: forkId,
            ...lineage,
            pendingMessageId: command.pendingMessageId ?? null,
          },
          turnId: null,
          createdAt: command.createdAt,
        },
      },
      source.id,
    ),
  );
  return events;
});
