/**
 * ThreadMessages projector — handles thread message upserts and reverts.
 *
 * @module ProjectionPipeline.projector.threadMessages
 */
import { type OrchestrationEvent } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
  collectThreadAttachmentRelativePaths,
  materializeAttachmentsForProjection,
  retainProjectionMessagesAfterRevert,
} from "./ProjectionPipeline.helpers.ts";
import { type ProjectorDefinition, type ProjectorDeps } from "./ProjectionPipeline.projectors.ts";

export function makeThreadMessagesProjector(
  deps: Pick<ProjectorDeps, "projectionThreadMessageRepository" | "projectionTurnRepository">,
): ProjectorDefinition {
  const { projectionThreadMessageRepository, projectionTurnRepository } = deps;

  const apply = Effect.fn("applyThreadMessagesProjection")(function* (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) {
    switch (event.type) {
      case "thread.message-sent": {
        const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
          messageId: event.payload.messageId,
        });
        const previousMessage = Option.getOrUndefined(existingMessage);
        const nextText = Option.match(existingMessage, {
          onNone: () => event.payload.text,
          onSome: (message) => {
            if (event.payload.replace === true) {
              return event.payload.text;
            }
            if (event.payload.streaming) {
              return `${message.text}${event.payload.text}`;
            }
            if (event.payload.text.length === 0) {
              return message.text;
            }
            return event.payload.text;
          },
        });
        const nextAttachments =
          event.payload.attachments !== undefined
            ? yield* materializeAttachmentsForProjection({
                attachments: event.payload.attachments,
              })
            : previousMessage?.attachments;
        yield* projectionThreadMessageRepository.upsert({
          messageId: event.payload.messageId,
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          role: event.payload.role,
          text: nextText,
          ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
          ...(event.payload.replyTo !== undefined
            ? { replyTo: event.payload.replyTo }
            : previousMessage?.replyTo !== undefined
              ? { replyTo: previousMessage.replyTo }
              : {}),
          isStreaming: event.payload.streaming,
          createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      case "thread.reverted": {
        const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        if (existingRows.length === 0) {
          return;
        }

        const existingTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        const keptRows = retainProjectionMessagesAfterRevert(
          existingRows,
          existingTurns,
          event.payload.turnCount,
        );
        if (keptRows.length === existingRows.length) {
          return;
        }

        yield* projectionThreadMessageRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
          concurrency: 1,
        }).pipe(Effect.asVoid);
        attachmentSideEffects.prunedThreadRelativePaths.set(
          event.payload.threadId,
          collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
        );
        return;
      }

      default:
        return;
    }
  });

  return { name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages, apply };
}
