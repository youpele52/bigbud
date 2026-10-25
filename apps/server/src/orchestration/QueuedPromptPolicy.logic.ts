import type {
  CommandId,
  MessageId,
  OrchestrationQueuedPrompt,
  OrchestrationThread,
} from "@bigbud/contracts";
import { Equal } from "effect";

import { canUserReleasePendingTurnStart } from "./PendingTurnStart.logic.ts";
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

/**
 * A busy-refused message was sent before anything still queued, so it is redelivered first:
 * after prompts an interrupt or control operation already captured, and after earlier
 * redeliveries. Returns a 1-based queue position.
 */
export function redeliveryQueuePosition(thread: OrchestrationThread): number {
  const prompts = thread.queuedPrompts ?? [];
  const captured = new Set<MessageId>([
    ...(thread.pendingInterruptFlushIntent?.queuedPromptIds ?? []),
    ...(hasActiveQueueReservation(thread)
      ? (thread.pendingTurnControlOperation?.reservedPromptIds ?? [])
      : []),
  ]);
  const index = prompts.findIndex(
    (prompt) => !captured.has(prompt.id) && prompt.alreadySent !== true,
  );
  return (index < 0 ? prompts.length : index) + 1;
}

/** Already-sent redeliveries sit outside the user's visible queue limit. */
export function countedQueuedPrompts(prompts: ReadonlyArray<OrchestrationQueuedPrompt>): number {
  return prompts.filter((prompt) => prompt.alreadySent !== true).length;
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

/** Prompts that must start their own turn under their own message ID. */
export function hasNonCombinableQueuedPromptMetadata(prompt: OrchestrationQueuedPrompt): boolean {
  return Boolean(
    prompt.alreadySent ||
    prompt.text.trim().length === 0 ||
    prompt.attachments?.length ||
    prompt.replyTo ||
    prompt.titleSeed ||
    prompt.bootstrapSourceThreadId ||
    prompt.sourceProposedPlan,
  );
}

/** Explicit and inherited options never share a turn, even if today's defaults match. */
export function compatibleQueuedPrefix(prompts: ReadonlyArray<OrchestrationQueuedPrompt>) {
  const first = prompts[0];
  if (!first) return [];
  if (hasNonCombinableQueuedPromptMetadata(first)) return [first];
  const end = prompts.findIndex(
    (prompt) =>
      hasNonCombinableQueuedPromptMetadata(prompt) || !sameQueuedPromptOptions(first, prompt),
  );
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
        prompt.interactionMode === undefined &&
        !hasNonCombinableQueuedPromptMetadata(prompt),
    )
  );
}

/**
 * The user's explicit "Send now" may override a pending start that has held the queue too long,
 * so a start that hung without binding or failing cannot block the thread forever.
 */
export function userReleasesStalePendingTurnStart(input: {
  readonly thread: OrchestrationThread;
  readonly userRelease?: boolean | undefined;
  readonly controlOperationId?: CommandId | undefined;
  readonly releasedAt?: string | undefined;
}): boolean {
  return (
    input.userRelease === true &&
    input.controlOperationId === undefined &&
    input.thread.pendingTurnStart != null &&
    input.releasedAt !== undefined &&
    canUserReleasePendingTurnStart(input.thread, input.releasedAt)
  );
}

export function consumableQueuedPrefix(input: {
  readonly thread: OrchestrationThread;
  readonly messageIds: ReadonlyArray<MessageId>;
  readonly controlOperationId?: CommandId | undefined;
  readonly consumeOnly?: boolean | undefined;
  /** The user's explicit "Send now"; only it may release a held queue (`queueHold`). */
  readonly userRelease?: boolean | undefined;
  /**
   * Server time of the user's release; lets "Send now" override a stale pending start. Never a
   * command's client-set `createdAt`, so a client clock running ahead cannot release early.
   */
  readonly releasedAt?: string | undefined;
}) {
  const { thread, messageIds, controlOperationId, consumeOnly } = input;
  const userReleasesHold = input.userRelease === true && controlOperationId === undefined;
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
  } else if (
    hasActiveQueueReservation(thread) ||
    (thread.queueHold && !userReleasesHold) ||
    consumeOnly
  )
    return [];
  const dispatchThread = userReleasesStalePendingTurnStart(input)
    ? { ...thread, pendingTurnStart: null }
    : thread;
  if (!consumeOnly && !isThreadConfirmedIdleForDispatch(dispatchThread)) return [];
  const intent = thread.pendingInterruptFlushIntent;
  if (
    intent &&
    (!samePromptIds(intent.queuedPromptIds, messageIds) ||
      (controlOperationId !== undefined && intent.intentId !== controlOperationId))
  )
    return [];
  const prefix = exactQueuedPrefix(thread, messageIds);
  const compatible = compatibleQueuedPrefix(prefix);
  // Ordinary lifecycle/manual flushes may request a longer queue snapshot and
  // should consume its safe compatible head. Control reservations must remain
  // exact so a stale or malformed reservation is never partially consumed.
  const hasControlReservation =
    controlOperationId !== undefined ||
    consumeOnly ||
    thread.pendingInterruptFlushIntent !== undefined;
  return !hasControlReservation ? compatible : compatible.length === prefix.length ? prefix : [];
}
