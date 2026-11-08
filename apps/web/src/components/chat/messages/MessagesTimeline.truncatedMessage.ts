import type { MessageId, NativeApi, ThreadId } from "@bigbud/contracts";
import { MESSAGE_TEXT_CHUNK_MAX_LENGTH } from "@bigbud/contracts/orchestration/orchestration.detail.paging.ts";
import { createContext } from "react";

/** The server thread a timeline renders; truncated messages load their text through it. */
export const TimelineThreadIdContext = createContext<ThreadId | null>(null);

type ChunkApi = Pick<NativeApi["orchestration"], "getMessageTextChunk">;

export interface LoadedMessageText {
  readonly text: string;
  /** Offset of the next chunk in server characters, or null once the whole text is loaded. */
  readonly nextOffset: number | null;
  readonly textLength: number;
}

/**
 * Loads the next bounded chunk. The first chunk starts at offset 0 and replaces the preview:
 * server offsets count characters, the store preview counts UTF-16 units, and they can differ.
 */
export async function loadNextMessageTextChunk(input: {
  readonly api: ChunkApi;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly loaded: LoadedMessageText | null;
}): Promise<LoadedMessageText> {
  const offset = input.loaded?.nextOffset ?? 0;
  const chunk = await input.api.getMessageTextChunk({
    threadId: input.threadId,
    messageId: input.messageId,
    offset,
    limit: MESSAGE_TEXT_CHUNK_MAX_LENGTH,
  });
  return {
    text: `${input.loaded?.text ?? ""}${chunk.text}`,
    nextOffset: chunk.nextOffset,
    textLength: chunk.textLength,
  };
}

/** Full text for copy and export, never the truncated store copy; one bounded chunk per call. */
export async function readFullMessageText(input: {
  readonly api: ChunkApi;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}): Promise<string> {
  let loaded: LoadedMessageText | null = null;
  // The length is known after the first chunk; the guard stops a text that keeps growing.
  for (let calls = 0; loaded === null || loaded.nextOffset !== null; calls += 1) {
    const maxCalls = loaded ? Math.ceil(loaded.textLength / MESSAGE_TEXT_CHUNK_MAX_LENGTH) + 1 : 1;
    if (calls >= maxCalls) break;
    loaded = await loadNextMessageTextChunk({ ...input, loaded });
  }
  // Never hand back part of the text as if it were all of it.
  if (loaded?.nextOffset != null) throw new Error("The message kept growing while it was read.");
  return loaded?.text ?? "";
}

export function formatTextSize(characters: number): string {
  if (characters < 1024) return `${characters} characters`;
  if (characters < 1024 * 1024) return `${Math.round(characters / 1024)} KB`;
  return `${(characters / (1024 * 1024)).toFixed(1)} MB`;
}
