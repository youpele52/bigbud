import type { MessageId, ThreadId } from "@bigbud/contracts";
import type { SystemSearchHit } from "@bigbud/contracts/search/systemSearch.ts";

export interface ThreadSearchResult {
  id: string;
  threadId: ThreadId;
  title: string;
  projectName: string;
  matchedMessageText: string;
  type: "thread";
}

export interface MessageSearchResult {
  id: string;
  threadId: ThreadId;
  messageId: MessageId;
  threadTitle: string;
  projectName: string;
  text: string;
  snippet: string;
  matchIndex: number;
  type: "message";
}

/** A file or folder row from `search.query` (T2, T4, T5, T6); `id` is the stable row ID. */
export type FileSearchResult = SystemSearchHit;

export function getThreadItemValue(result: ThreadSearchResult): string {
  return `${result.title} ${result.projectName} ${result.matchedMessageText}`.toLowerCase();
}

export function getFileItemValue(result: FileSearchResult): string {
  return result.id;
}
