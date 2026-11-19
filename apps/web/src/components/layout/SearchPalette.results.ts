import { type MessageId, type ProjectFileContentMatch, type ThreadId } from "@bigbud/contracts";

import { searchResultId } from "./SearchPalette.tiers.logic";

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

export interface FileSearchResult {
  id: string;
  path: string;
  line: number;
  column: number | null;
  lineText: string;
  type: "file";
}

export function getThreadItemValue(result: ThreadSearchResult): string {
  return `${result.title} ${result.projectName} ${result.matchedMessageText}`.toLowerCase();
}

export function getFileItemValue(result: FileSearchResult): string {
  return `${result.path} ${result.lineText}`.toLowerCase();
}

export function toFileSearchResults(
  matches: readonly ProjectFileContentMatch[],
): FileSearchResult[] {
  return matches.map((match) => ({
    // Column keeps two matches on one line distinct.
    id: `${searchResultId({
      tier: "currentProject",
      source: "content",
      target: "workspace",
      path: match.path,
      line: match.line,
    })}:${match.column ?? 0}`,
    path: match.path,
    line: match.line,
    column: match.column ?? null,
    lineText: match.lineText,
    type: "file",
  }));
}
