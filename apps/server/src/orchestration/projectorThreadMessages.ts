import {
  OrchestrationMessage,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationProjectorDecodeError } from "./Errors.ts";
import { MessageSentPayloadSchema } from "./Schemas.ts";
import { decodeForEvent, updateThread } from "./projectorHelpers.ts";

const MAX_THREAD_MESSAGES = 2_000;

export function projectThreadMessageSent(
  model: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return Effect.gen(function* () {
    const payload = yield* decodeForEvent(
      MessageSentPayloadSchema,
      event.payload,
      event.type,
      "payload",
    );
    const thread = model.threads.find((entry) => entry.id === payload.threadId);
    if (!thread) return model;
    const message: OrchestrationMessage = yield* decodeForEvent(
      OrchestrationMessage,
      {
        id: payload.messageId,
        role: payload.role,
        text: payload.text,
        ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
        turnId: payload.turnId,
        streaming: payload.streaming,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      },
      event.type,
      "message",
    );
    const existingMessage = thread.messages.find((entry) => entry.id === message.id);
    const messages = existingMessage
      ? thread.messages.map((entry) =>
          entry.id === message.id
            ? {
                ...entry,
                text:
                  event.payload.replace === true
                    ? message.text
                    : message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                streaming: message.streaming,
                updatedAt: message.updatedAt,
                turnId: message.turnId,
                ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
              }
            : entry,
        )
      : [...thread.messages, message];
    return {
      ...model,
      threads: updateThread(model.threads, payload.threadId, {
        messages: messages.slice(-MAX_THREAD_MESSAGES),
        updatedAt: event.occurredAt,
      }),
    };
  });
}
