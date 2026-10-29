import { withEventBase } from "./deciderHelpers.ts";
import type {
  OrchestrationCommand,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationEvent,
} from "@bigbud/contracts";
import { Effect, Equal } from "effect";
import {
  evaluateQueuedPromptFlush,
  exactQueuedPrefix,
  compatibleQueuedPrefix,
  terminalTurnControlStates,
} from "./QueuedPromptPolicy.logic.ts";
import { queueDecisionError } from "./QueuedPromptDecision.logic.ts";
import { decideThreadSessionCommand } from "./deciderThreads.turn.session.ts";

/** A manual release can interrupt only the exact turn the user observed. */
export const decideQueuedReleaseInterrupt = Effect.fn("decideQueuedReleaseInterrupt")(
  function* (input: {
    command: Extract<OrchestrationCommand, { type: "thread.queued-prompt.flush" }>;
    thread: OrchestrationThread;
    readModel: OrchestrationReadModel;
  }) {
    const { command, thread, readModel } = input;
    if (!command.userRelease || command.controlOperationId !== undefined) return null;
    if (
      command.expectedSessionEpoch !== undefined &&
      command.expectedSessionEpoch !== (thread.session?.sessionEpoch ?? 0)
    )
      return yield* queueDecisionError("queue_stale_turn");
    const turnId = thread.session?.activeTurnId;
    if (turnId == null || command.expectedTurnId === undefined) return null;
    if (command.expectedSessionEpoch === undefined || command.expectedTurnId !== turnId)
      return yield* queueDecisionError("queue_stale_turn");
    if (
      (thread.pendingTurnControlOperation &&
        !terminalTurnControlStates.has(thread.pendingTurnControlOperation.state)) ||
      thread.pendingInterruptFlushIntent
    )
      return yield* queueDecisionError("queue_reserved");
    // Validate selection/incarnation with only the active-turn gate removed. Never remove pending start,
    // approval, input, deletion, or ownership protection.
    const decision = evaluateQueuedPromptFlush({
      ...command,
      thread: {
        ...thread,
        session: thread.session ? { ...thread.session, activeTurnId: null, status: "ready" } : null,
      },
    });
    if (decision.status !== "ready") return yield* queueDecisionError(decision.reason);
    const prefix = compatibleQueuedPrefix(exactQueuedPrefix(thread, command.messageIds));
    return yield* decideThreadSessionCommand({
      readModel,
      command: {
        type: "thread.turn.interrupt",
        commandId: command.commandId,
        threadId: thread.id,
        turnId,
        sessionEpoch: thread.session?.sessionEpoch ?? 0,
        queuedPromptIdsAfterSettlement: prefix.map((prompt) => prompt.id),
        createdAt: command.createdAt,
      },
    });
  },
);

/** These settings events commit with the flush/start, never before the authoritative idle check. */
export function queuedReleaseSettingsEvents(
  command: Extract<OrchestrationCommand, { type: "thread.queued-prompt.flush" }>,
  thread: OrchestrationThread,
): Array<Omit<OrchestrationEvent, "sequence">> {
  const settings = command.userRelease ? command.releaseSettings : undefined;
  if (!settings) return [];
  const base = () =>
    withEventBase({
      aggregateKind: "thread",
      aggregateId: thread.id,
      commandId: command.commandId,
      occurredAt: command.createdAt,
    });
  const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
  if (settings.modelSelection && !Equal.equals(settings.modelSelection, thread.modelSelection))
    events.push({
      ...base(),
      type: "thread.meta-updated",
      payload: {
        threadId: thread.id,
        modelSelection: settings.modelSelection,
        updatedAt: command.createdAt,
      },
    });
  if (settings.runtimeMode !== thread.runtimeMode)
    events.push({
      ...base(),
      type: "thread.runtime-mode-set",
      payload: {
        threadId: thread.id,
        runtimeMode: settings.runtimeMode,
        updatedAt: command.createdAt,
      },
    });
  if (settings.interactionMode !== thread.interactionMode)
    events.push({
      ...base(),
      type: "thread.interaction-mode-set",
      payload: {
        threadId: thread.id,
        interactionMode: settings.interactionMode,
        updatedAt: command.createdAt,
      },
    });
  return events;
}
