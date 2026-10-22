import { CommandId, EventId, MessageId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type {
  OrchestrationReadModel,
  OrchestrationSession,
  OrchestrationThread,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { USER_TURN_BOUND } from "@bigbud/shared/internalTextGeneration";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { now, readModel, threadId } from "./deciderThreads.turn.queue.test.helpers.ts";
import { projectEvent } from "./projector.ts";
import { makeLifecycleQueuedPromptFlushCommand } from "./QueuedPromptFlush.logic.ts";

export { threadId };

let commandCounter = 0;
const nextCommandId = (tag: string) => CommandId.makeUnsafe(`${tag}-${++commandCounter}`);

/** Runs one command through the real decider and in-memory projector. */
export async function apply(
  model: OrchestrationReadModel,
  command: OrchestrationCommand,
): Promise<OrchestrationReadModel> {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({ command, readModel: model }),
  );
  const events = (Array.isArray(decided) ? decided : [decided]) as ReadonlyArray<
    Omit<OrchestrationEvent, "sequence">
  >;
  let next = model;
  for (const event of events) {
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 } as OrchestrationEvent),
    );
  }
  return next;
}

/** Applies a lifecycle trigger, then the queue flush it produces, as the engine does. */
export async function applyWithLifecycleFlush(
  model: OrchestrationReadModel,
  trigger: OrchestrationCommand,
): Promise<{ readonly model: OrchestrationReadModel; readonly flushed: boolean }> {
  const afterTrigger = await apply(model, trigger);
  const flush = makeLifecycleQueuedPromptFlushCommand({
    trigger,
    readModel: afterTrigger,
    createdAt: now,
  });
  if (!flush) return { model: afterTrigger, flushed: false };
  return { model: await apply(afterTrigger, flush), flushed: true };
}

export const thread = (model: OrchestrationReadModel): OrchestrationThread =>
  model.threads.find((entry) => entry.id === threadId)!;

export const queuedIds = (model: OrchestrationReadModel) =>
  (thread(model).queuedPrompts ?? []).map((prompt) => prompt.id);

export function sessionSet(
  model: OrchestrationReadModel,
  status: OrchestrationSession["status"],
  activeTurnId: string | null = null,
  options: { readonly advanceSessionEpoch?: boolean } = {},
): OrchestrationCommand {
  return {
    type: "thread.session.set",
    commandId: nextCommandId("session"),
    threadId,
    session: {
      threadId,
      status,
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: activeTurnId === null ? null : TurnId.makeUnsafe(activeTurnId),
      lastError: status === "error" ? "provider failed" : null,
      updatedAt: now,
    },
    expectedSessionEpoch: thread(model).session?.sessionEpoch ?? 0,
    ...(options.advanceSessionEpoch ? { advanceSessionEpoch: true } : {}),
    createdAt: now,
  };
}

export function userTurnBound(messageId: MessageId, turnId: string): OrchestrationCommand {
  const id = `text-generation-user-turn:${threadId}:${messageId}:${turnId}`;
  return {
    type: "thread.activity.append",
    commandId: nextCommandId("bound"),
    threadId,
    activity: {
      id: EventId.makeUnsafe(id),
      kind: USER_TURN_BOUND,
      tone: "info",
      summary: "User turn submitted",
      turnId: TurnId.makeUnsafe(turnId),
      payload: { messageId },
      createdAt: now,
    },
    createdAt: now,
  };
}

const queued = (id: string) => ({ id: MessageId.makeUnsafe(id), text: id, createdAt: now });

/**
 * The reported repro, up to the race: a running turn, `queued-a` and `queued-b`
 * captured by an interrupt, `queued-c` queued afterwards, then the interrupted
 * turn settles and the continuation flushes a+b and requests their turn.
 */
export async function interruptContinuationRequested(): Promise<OrchestrationReadModel> {
  let model: OrchestrationReadModel = readModel({
    queuedPrompts: [queued("queued-a"), queued("queued-b")],
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: TurnId.makeUnsafe("turn-old"),
      lastError: null,
      updatedAt: now,
    },
  });
  model = await apply(model, {
    type: "thread.turn.interrupt",
    commandId: nextCommandId("interrupt"),
    threadId,
    turnId: TurnId.makeUnsafe("turn-old"),
    queuedPromptIdsAfterSettlement: [
      MessageId.makeUnsafe("queued-a"),
      MessageId.makeUnsafe("queued-b"),
    ],
    createdAt: now,
  });
  model = await apply(model, {
    type: "thread.turn.start",
    commandId: nextCommandId("send-c"),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe("queued-c"),
      role: "user",
      text: "C",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
  } as OrchestrationCommand);
  // The interrupted turn settles; the reservation holds the queue against lifecycle flushes.
  model = (await applyWithLifecycleFlush(model, sessionSet(model, "ready"))).model;
  // The reactor's interrupt continuation flushes exactly the reservation, then completes it.
  const operation = thread(model).pendingTurnControlOperation!;
  model = await apply(model, {
    type: "thread.queued-prompt.flush",
    commandId: nextCommandId("interrupt-continue-flush"),
    threadId,
    messageIds: operation.reservedPromptIds,
    messageId: MessageId.makeUnsafe(`continued:${operation.operationId}`),
    acknowledged: true,
    controlOperationId: operation.operationId,
    createdAt: now,
  });
  return apply(model, {
    type: "thread.turn-control.set",
    commandId: nextCommandId("turn-control"),
    threadId,
    operation: { ...operation, state: "completed", updatedAt: now },
    expectedOperationId: operation.operationId,
    createdAt: now,
  });
}
