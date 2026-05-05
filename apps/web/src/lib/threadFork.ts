/**
 * Thread forking utilities.
 *
 * Handles message filtering, capping, and preparation for fork operations.
 */
import { type MessageId } from "@bigbud/contracts";
import { newMessageId } from "./utils";

/**
 * Maximum seed messages allowed by server to prevent event amplification.
 * @see apps/server/src/orchestration/deciderThreads.lifecycle.ts
 */
export const MAX_SEED_MESSAGES = 200;

export interface SeedMessageInput {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<
    | {
        readonly type: "image";
        readonly id: string;
        readonly name: string;
        readonly mimeType: string;
        readonly sizeBytes: number;
      }
    | {
        readonly type: "file";
        readonly id: string;
        readonly name: string;
        readonly mimeType: string;
        readonly sizeBytes: number;
        readonly sourcePath?: string;
      }
  >;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly completedAt?: string | null | undefined;
}

export interface SeedMessageOutput {
  readonly id: MessageId;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<
    | {
        readonly type: "image";
        readonly id: string;
        readonly name: string;
        readonly mimeType: string;
        readonly sizeBytes: number;
      }
    | {
        readonly type: "file";
        readonly id: string;
        readonly name: string;
        readonly mimeType: string;
        readonly sizeBytes: number;
        readonly sourcePath?: string;
      }
  >;
  readonly turnId: null;
  readonly streaming: false;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Prepares seed messages for a forked thread.
 *
 * - Filters out streaming messages
 * - Caps to newest `MAX_SEED_MESSAGES` messages
 * - Maps to the seed message format expected by `thread.create`
 *
 * @param messages Source thread messages
 * @returns Seed messages ready for `thread.create` command
 */
export function prepareSeedMessages(
  messages: ReadonlyArray<SeedMessageInput>,
): ReadonlyArray<SeedMessageOutput> {
  const nonStreaming = messages.filter((message) => !message.streaming);
  const capped =
    nonStreaming.length > MAX_SEED_MESSAGES ? nonStreaming.slice(-MAX_SEED_MESSAGES) : nonStreaming;

  return capped.map((message) =>
    Object.assign(
      {
        id: newMessageId(),
        role: message.role,
        text: message.text,
      },
      message.attachments && message.attachments.length > 0
        ? {
            attachments: message.attachments.map((attachment) => {
              if (attachment.type === "image") {
                return {
                  type: "image" as const,
                  id: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                };
              }
              return {
                type: "file" as const,
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                ...(attachment.sourcePath ? { sourcePath: attachment.sourcePath } : {}),
              };
            }),
          }
        : {},
      {
        turnId: null,
        streaming: false as const,
        createdAt: message.createdAt,
        updatedAt: message.completedAt ?? message.createdAt,
      },
    ),
  );
}

/**
 * Type guard to check if messages conform to SeedMessageInput.
 */
export function isSeedMessageInput(
  messages: ReadonlyArray<unknown>,
): messages is ReadonlyArray<SeedMessageInput> {
  return messages.every(
    (msg): msg is SeedMessageInput =>
      typeof msg === "object" &&
      msg !== null &&
      "id" in msg &&
      "role" in msg &&
      "text" in msg &&
      "streaming" in msg &&
      "createdAt" in msg,
  );
}
