/**
 * Provenance filters shared by every cross-project confirmation path: chat-reply proof and
 * implicit approval from the user's own request. Trust comes from the command ID and the message
 * origin segments, never from `actor_kind`.
 *
 * @module ThreadCoordinationConfirmation.trust
 */
import type { OrchestrationEvent } from "@bigbud/contracts";
import type { MessageOriginSegment } from "@bigbud/contracts/orchestration/orchestration.messageOrigin.ts";

import { QUEUE_FLUSH_COMMAND_PREFIX } from "../orchestration/QueuedPromptFlush.logic.ts";

/** Server-, provider- and missing command IDs never carry a user action. */
export const isUntrustedCommandId = (commandId: string | null) =>
  commandId === null || commandId.startsWith("server:") || commandId.startsWith("provider:");

export const isQueueFlushCommandId = (commandId: string | null) =>
  commandId !== null && commandId.startsWith(QUEUE_FLUSH_COMMAND_PREFIX);

/** Only user-typed text counts: no segments, or only `ordinaryUser` segments typed by the user. */
export function userTypedText(
  text: string,
  segments: ReadonlyArray<MessageOriginSegment> | undefined,
): string | null {
  if (segments === undefined) return text;
  const userOnly = segments.every(
    (segment) => segment.kind === "ordinaryUser" && segment.actor === "user",
  );
  return userOnly ? segments.map((segment) => segment.text).join("\n") : null;
}

/** The text of a trusted user-typed chat message, or null for anything else. */
export function trustedChatText(event: OrchestrationEvent): string | null {
  if (isUntrustedCommandId(event.commandId)) return null;
  if (event.type === "thread.message-sent") {
    // A queue flush re-sends prompts whose original `thread.prompt-queued` is already scanned.
    if (event.payload.role !== "user" || isQueueFlushCommandId(event.commandId)) return null;
    return userTypedText(event.payload.text, event.payload.originSegments);
  }
  if (event.type === "thread.prompt-queued") {
    if (event.payload.prompt.alreadySent === true) return null;
    return userTypedText(event.payload.prompt.text, event.payload.prompt.originSegments);
  }
  return null;
}
