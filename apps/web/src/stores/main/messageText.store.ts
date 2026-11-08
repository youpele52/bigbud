import {
  THREAD_DETAIL_TEXT_PREVIEW_LENGTH,
  THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";

import type { NativeApi, ThreadId } from "@bigbud/contracts";
import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import { readFullMessageText } from "~/components/chat/messages/MessagesTimeline.truncatedMessage";
import { readNativeApi } from "~/rpc/nativeApi";

import type { ChatMessage } from "../../models/types";

/** The text fields of a stored message; `textLength` is set only while `textTruncated` is. */
export type BoundedMessageText = Pick<ChatMessage, "text" | "textTruncated" | "textLength">;

/**
 * Applies the detail query's size rule in the client store: text over 256 KB keeps its first
 * 64 KB and records the full length, so the store never holds an unbounded string.
 */
export function boundMessageText(text: string, knownLength = text.length): BoundedMessageText {
  if (knownLength <= THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD) return { text };
  // Never end the preview on half of a surrogate pair.
  const lastCode = text.charCodeAt(THREAD_DETAIL_TEXT_PREVIEW_LENGTH - 1);
  const end =
    THREAD_DETAIL_TEXT_PREVIEW_LENGTH - (lastCode >= 0xd800 && lastCode <= 0xdbff ? 1 : 0);
  return { text: text.slice(0, end), textTruncated: true, textLength: knownLength };
}

/** Streaming deltas past a truncated preview only grow the recorded length. */
export function appendBoundedMessageText(entry: ChatMessage, delta: string): BoundedMessageText {
  if (entry.textTruncated === true) {
    return {
      text: entry.text,
      textTruncated: true,
      textLength: (entry.textLength ?? entry.text.length) + delta.length,
    };
  }
  return boundMessageText(`${entry.text}${delta}`);
}

/** The text a `thread.message-sent` event leaves on an existing message, bounded. */
export function resolveUpsertedMessageText(
  entry: ChatMessage,
  message: ChatMessage,
  replace: boolean,
): BoundedMessageText {
  if (replace) return boundMessageText(message.text);
  if (message.streaming) return appendBoundedMessageText(entry, message.text);
  if (message.text.length > 0) return boundMessageText(message.text);
  return {
    text: entry.text,
    ...(entry.textTruncated === true
      ? { textTruncated: true, textLength: entry.textLength ?? entry.text.length }
      : {}),
  };
}

/** Drops the bounded-text fields so a shorter replacement does not inherit a stale flag. */
export function withoutTextBounds(message: ChatMessage): ChatMessage {
  const { textTruncated: _textTruncated, textLength: _textLength, ...rest } = message;
  return rest;
}

/** Live activity payloads follow the detail query's rule: over 256 KB becomes `{}` plus flags. */
export function boundActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  if (activity.payloadTruncated === true || activity.payload === null) return activity;
  if (typeof activity.payload !== "object" && typeof activity.payload !== "string") return activity;
  const payloadLength = JSON.stringify(activity.payload)?.length ?? 0;
  if (payloadLength <= THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD) return activity;
  return { ...activity, payload: {}, payloadTruncated: true, payloadLength };
}

/**
 * The whole text of a stored message: the store copy when it is complete, otherwise every
 * bounded chunk from the server. Rejects rather than returning a preview as the full text.
 */
export async function resolveFullMessageText(
  threadId: ThreadId,
  message: Pick<ChatMessage, "id" | "text" | "textTruncated">,
  api:
    | { readonly orchestration: Pick<NativeApi["orchestration"], "getMessageTextChunk"> }
    | undefined = readNativeApi(),
): Promise<string> {
  if (message.textTruncated !== true) return message.text;
  if (!api) throw new Error("bigbud is not connected to the server.");
  return readFullMessageText({ api: api.orchestration, threadId, messageId: message.id });
}
