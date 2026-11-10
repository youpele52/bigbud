/**
 * Implicit approval (Settled decision 3a): a clear request from the user is the approval. A
 * cross-project write needs no question when the caller thread's latest user-role message is the
 * user's own, references the target, and nothing from another source came after it. It covers the
 * current request only and never records a grant.
 *
 * @module ThreadCoordinationConfirmation.implicit
 */
import type { ChatAttachment, OrchestrationEvent, ThreadId } from "@bigbud/contracts";

import {
  isQueueFlushCommandId,
  isUntrustedCommandId,
  userTypedText,
} from "./ThreadCoordinationConfirmation.trust.ts";

/** Recent user-turn events read per check; a turn adds at most a few, a queue at most five. */
export const IMPLICIT_APPROVAL_EVENT_WINDOW = 64;

/** Whether an attached thread ID names the write's target (or, for `create_thread`, its project). */
export type ThreadCoordinationTargetReference = (threadId: string) => boolean;

type EventOf<T extends OrchestrationEvent["type"]> = Extract<OrchestrationEvent, { type: T }>;

const isUserMessage = (event: OrchestrationEvent): event is EventOf<"thread.message-sent"> =>
  event.type === "thread.message-sent" && event.payload.role === "user";

/** A queued prompt the user typed: trusted command, user-only segments, optionally not a re-send. */
function isUserQueuedPrompt(
  event: EventOf<"thread.prompt-queued">,
  options: { readonly allowAlreadySent: boolean },
): boolean {
  const { prompt } = event.payload;
  if (isUntrustedCommandId(event.commandId) || isQueueFlushCommandId(event.commandId)) return false;
  if (!options.allowAlreadySent && prompt.alreadySent === true) return false;
  return userTypedText(prompt.text, prompt.originSegments) !== null;
}

/**
 * The attachments of the user's own request, or null when its provenance is not the user's.
 * A queue flush (the user typed while the agent was busy) is resolved through the original
 * queued prompts it delivered; their attachments count, since a merged flush keeps only the
 * first prompt's.
 */
function userRequestAttachments(
  message: EventOf<"thread.message-sent">,
  earlier: ReadonlyArray<OrchestrationEvent>,
): ReadonlyArray<ChatAttachment> | null {
  if (userTypedText(message.payload.text, message.payload.originSegments) === null) return null;
  const attachments = [...(message.payload.attachments ?? [])];
  const flushed = earlier.findLast(
    (event): event is EventOf<"thread.queued-prompts-flushed"> =>
      event.type === "thread.queued-prompts-flushed" && event.commandId === message.commandId,
  );
  if (flushed === undefined) {
    // A server queue flush is only trusted through the prompts it delivered.
    return isQueueFlushCommandId(message.commandId) ? null : attachments;
  }
  for (const promptId of flushed.payload.messageIds) {
    const original = earlier.findLast(
      (event): event is EventOf<"thread.prompt-queued"> =>
        event.type === "thread.prompt-queued" &&
        event.sequence < flushed.sequence &&
        event.payload.prompt.id === promptId,
    );
    if (original === undefined || !isUserQueuedPrompt(original, { allowAlreadySent: false })) {
      return null;
    }
    attachments.push(...(original.payload.prompt.attachments ?? []));
  }
  return attachments;
}

/** Decides implicit approval from the caller thread's recent user-turn events. */
export function matchImplicitThreadCoordinationApproval(input: {
  readonly callerThreadId: ThreadId;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly referencesTarget: ThreadCoordinationTargetReference;
}): boolean {
  const events = input.events
    .filter(
      (event) =>
        event.aggregateKind === "thread" &&
        event.aggregateId === input.callerThreadId &&
        (event.payload as { readonly threadId?: unknown }).threadId === input.callerThreadId,
    )
    .toSorted((left, right) => left.sequence - right.sequence);
  const latestIndex = events.findLastIndex(isUserMessage);
  const message = events[latestIndex];
  if (message === undefined || !isUserMessage(message)) return false;
  if (isUntrustedCommandId(message.commandId)) return false;

  // Another source queued (or steered) something after the user's request: ask instead.
  const later = events.slice(latestIndex + 1);
  if (
    later.some(
      (event) =>
        event.type === "thread.prompt-queued" &&
        !isUserQueuedPrompt(event, { allowAlreadySent: true }),
    )
  ) {
    return false;
  }

  // Only a message that started the user's turn counts; fork and branch copies of history
  // reuse the user's command ID but never request a turn for the copied message.
  const startedTurn = later.some(
    (event) =>
      event.type === "thread.turn-start-requested" &&
      event.commandId === message.commandId &&
      event.payload.messageId === message.payload.messageId,
  );
  if (!startedTurn) return false;

  const attachments = userRequestAttachments(message, events.slice(0, latestIndex));
  return (
    attachments?.some(
      (attachment) => attachment.type === "thread" && input.referencesTarget(attachment.threadId),
    ) === true
  );
}
