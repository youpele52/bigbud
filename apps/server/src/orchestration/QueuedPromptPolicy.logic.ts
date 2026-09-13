import type {
  CommandId,
  MessageId,
  OrchestrationQueuedPrompt,
  OrchestrationThread,
} from "@bigbud/contracts";
import { Equal } from "effect";

import { isThreadConfirmedIdleForDispatch } from "./ThreadDispatchSafety.logic.ts";

export const terminalTurnControlStates = new Set([
  "completed",
  "failed",
  "superseded",
  "cancelled",
]);

export function hasActiveQueueReservation(thread: OrchestrationThread): boolean {
  const operation = thread.pendingTurnControlOperation;
  return Boolean(
    operation?.reservedPromptIds.length && !terminalTurnControlStates.has(operation.state),
  );
}

export function canAutoDispatchQueuedPrompts(thread: OrchestrationThread): boolean {
  return (
    !thread.queueHold &&
    !hasActiveQueueReservation(thread) &&
    !thread.pendingInterruptFlushIntent &&
    isThreadConfirmedIdleForDispatch(thread)
  );
}

export function samePromptIds(
  left: ReadonlyArray<MessageId>,
  right: ReadonlyArray<MessageId>,
): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function exactQueuedPrefix(thread: OrchestrationThread, ids: ReadonlyArray<MessageId>) {
  const prefix = (thread.queuedPrompts ?? []).slice(0, ids.length);
  return ids.length > 0 &&
    samePromptIds(
      prefix.map((prompt) => prompt.id),
      ids,
    )
    ? prefix
    : [];
}

type QueueOptions = Pick<
  OrchestrationQueuedPrompt,
  "modelSelection" | "runtimeMode" | "interactionMode"
>;

export function sameQueuedPromptOptions(left: QueueOptions, right: QueueOptions): boolean {
  return (
    Equal.equals(left.modelSelection, right.modelSelection) &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode
  );
}

/** Explicit and inherited options never share a turn, even if today's defaults match. */
export function compatibleQueuedPrefix(prompts: ReadonlyArray<OrchestrationQueuedPrompt>) {
  const first = prompts[0];
  if (!first) return [];
  const end = prompts.findIndex((prompt) => !sameQueuedPromptOptions(first, prompt));
  return prompts.slice(0, end < 0 ? prompts.length : end);
}

export function queuedPrefixExecutionOptions(
  thread: OrchestrationThread,
  first: OrchestrationQueuedPrompt,
) {
  return {
    ...(first.modelSelection !== undefined ? { modelSelection: first.modelSelection } : {}),
    runtimeMode: first.runtimeMode ?? thread.runtimeMode,
    interactionMode: first.interactionMode ?? thread.interactionMode,
  };
}

/** The projection has no immutable active model/interaction snapshot. Use settlement
 * for explicit options rather than comparing them to mutable thread defaults. */
export function canNativelySteerQueuedPrefix(
  prompts: ReadonlyArray<OrchestrationQueuedPrompt>,
): boolean {
  return (
    prompts.length > 0 &&
    prompts.every(
      (prompt) =>
        prompt.modelSelection === undefined &&
        prompt.runtimeMode === undefined &&
        prompt.interactionMode === undefined,
    )
  );
}

export function consumableQueuedPrefix(input: {
  readonly thread: OrchestrationThread;
  readonly messageIds: ReadonlyArray<MessageId>;
  readonly controlOperationId?: CommandId | undefined;
  readonly consumeOnly?: boolean | undefined;
}) {
  const { thread, messageIds, controlOperationId, consumeOnly } = input;
  if (thread.archivedAt != null || thread.deletingAt != null || thread.deletedAt != null) return [];
  const operation = thread.pendingTurnControlOperation;
  if (controlOperationId !== undefined) {
    if (
      !operation ||
      operation.operationId !== controlOperationId ||
      terminalTurnControlStates.has(operation.state) ||
      operation.state === "ambiguous" ||
      operation.sessionEpoch !== (thread.session?.sessionEpoch ?? 0) ||
      !samePromptIds(operation.reservedPromptIds, messageIds)
    )
      return [];
    if (consumeOnly) {
      if (
        operation.strategy !== "native-steer" ||
        operation.state !== "provider-acknowledged" ||
        (thread.session?.activeTurnId != null &&
          thread.session.activeTurnId !== operation.expectedTurnId)
      )
        return [];
    } else if (operation.strategy !== "interrupt-continue") return [];
  } else if (hasActiveQueueReservation(thread) || thread.queueHold || consumeOnly) return [];
  if (!consumeOnly && !isThreadConfirmedIdleForDispatch(thread)) return [];
  const intent = thread.pendingInterruptFlushIntent;
  if (
    intent &&
    (!samePromptIds(intent.queuedPromptIds, messageIds) ||
      (controlOperationId !== undefined && intent.intentId !== controlOperationId))
  )
    return [];
  const prefix = exactQueuedPrefix(thread, messageIds);
  return compatibleQueuedPrefix(prefix).length === prefix.length ? prefix : [];
}
