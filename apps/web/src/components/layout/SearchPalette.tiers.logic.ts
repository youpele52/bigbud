import type { ProjectId, ThreadId } from "@bigbud/contracts";
import {
  CONVERSATION_SEARCH_MAX_QUERY_LENGTH,
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
  type ConversationMessageSearchHit,
  type SearchConversationMessagesResult,
} from "@bigbud/contracts/orchestration/orchestration.search";
import { countUnicodeCodePoints } from "@bigbud/shared/String";

import type { ProjectSearchResult } from "./SearchPalette.projectResults";
import type {
  FileSearchResult,
  MessageSearchResult,
  ThreadSearchResult,
} from "./SearchPalette.results";
import type { TerminalSearchResult } from "./SearchPalette.terminalResults.logic";

/**
 * Fixed tier order (plan §1). Scores only compare rows inside one tier; a later tier never
 * outranks an earlier one.
 */
export const SEARCH_TIERS = [
  "currentThread",
  "currentProject",
  "bigbudData",
  "otherProjectFiles",
  "thisComputer",
  "remoteOutsideProjects",
] as const;
export type SearchTier = (typeof SEARCH_TIERS)[number];

/** Stable row identity `tier:source:target:path[:line]`, used for React keys and cmdk values. */
export function searchResultId(input: {
  readonly tier: SearchTier;
  readonly source: string;
  readonly target: string;
  readonly path: string;
  readonly line?: number | undefined;
}): string {
  const base = `${input.tier}:${input.source}:${input.target}:${input.path}`;
  return input.line === undefined ? base : `${base}:${input.line}`;
}

export interface SearchContext {
  readonly currentThreadId: ThreadId | null;
  readonly currentProjectId: ProjectId | null;
}

/** Which sources run for a query length (plan "Short queries"). */
export function searchQueryRules(query: string, context: SearchContext) {
  const length = countUnicodeCodePoints(query.trim());
  const withinMax = length <= CONVERSATION_SEARCH_MAX_QUERY_LENGTH;
  return {
    titles: length >= 1,
    currentThreadMessages: context.currentThreadId !== null && length >= 1 && withinMax,
    messages: length >= CONVERSATION_SEARCH_MIN_QUERY_LENGTH && withinMax,
  };
}

function toMessageResult(
  hit: ConversationMessageSearchHit,
  tier: SearchTier,
  query: string,
): MessageSearchResult {
  return {
    id: searchResultId({ tier, source: "message", target: hit.threadId, path: hit.messageId }),
    threadId: hit.threadId,
    messageId: hit.messageId,
    threadTitle: hit.threadTitle,
    projectName: hit.projectName,
    text: hit.snippet,
    snippet: hit.snippet,
    matchIndex: hit.snippet.toLowerCase().indexOf(query.toLowerCase()),
    type: "message",
  };
}

export interface MessageTiers {
  readonly currentThread: MessageSearchResult[];
  readonly currentProject: MessageSearchResult[];
  readonly other: MessageSearchResult[];
}

/**
 * Splits saved-message pages into T1/T2/T3. Rows keep first-seen order (scoped first-page rows,
 * then global pages in fetch order), so a later page only appends and never reorders shown rows.
 */
export function partitionMessageTiers(
  pages: readonly SearchConversationMessagesResult[],
  context: SearchContext,
  query: string,
): MessageTiers {
  const tiers: MessageTiers = { currentThread: [], currentProject: [], other: [] };
  const seen = new Set<string>();
  const add = (hit: ConversationMessageSearchHit) => {
    if (seen.has(hit.messageId)) return;
    seen.add(hit.messageId);
    if (hit.threadId === context.currentThreadId) {
      tiers.currentThread.push(toMessageResult(hit, "currentThread", query));
    } else if (hit.projectId === context.currentProjectId) {
      tiers.currentProject.push(toMessageResult(hit, "currentProject", query));
    } else {
      tiers.other.push(toMessageResult(hit, "bigbudData", query));
    }
  };
  const first = pages[0];
  for (const hit of first?.currentThreadHits ?? []) add(hit);
  for (const hit of first?.currentProjectHits ?? []) add(hit);
  for (const page of pages) for (const hit of page.hits) add(hit);
  return tiers;
}

/** Thread-title matches: the current project's threads are T2, the rest T3. */
export function partitionThreadTiers(
  results: readonly (ThreadSearchResult & { readonly projectId: ProjectId })[],
  context: SearchContext,
): { currentProject: ThreadSearchResult[]; other: ThreadSearchResult[] } {
  const currentProject: ThreadSearchResult[] = [];
  const other: ThreadSearchResult[] = [];
  for (const { projectId, ...result } of results) {
    const tier = projectId === context.currentProjectId ? "currentProject" : "bigbudData";
    const id = searchResultId({ tier, source: "thread", target: "local", path: result.threadId });
    (tier === "currentProject" ? currentProject : other).push({ ...result, id });
  }
  return { currentProject, other };
}

/** Terminal output: the current thread's terminals are T1, the rest T3. */
export function partitionTerminalTiers(
  results: readonly TerminalSearchResult[],
  context: SearchContext,
): { currentThread: TerminalSearchResult[]; other: TerminalSearchResult[] } {
  const currentThread: TerminalSearchResult[] = [];
  const other: TerminalSearchResult[] = [];
  for (const result of results) {
    (result.threadId === context.currentThreadId ? currentThread : other).push(result);
  }
  return { currentThread, other };
}

/** Rows per tier section for the palette, in fixed tier order T1–T6. */
export interface SearchPaletteTiers {
  readonly currentThread: {
    readonly messages: MessageSearchResult[];
    readonly terminals: TerminalSearchResult[];
  };
  readonly currentProject: {
    readonly messages: MessageSearchResult[];
    readonly threads: ThreadSearchResult[];
    readonly files: FileSearchResult[];
  };
  readonly bigbudData: {
    readonly messages: MessageSearchResult[];
    readonly threads: ThreadSearchResult[];
    readonly projects: ProjectSearchResult[];
    readonly terminals: TerminalSearchResult[];
  };
  readonly otherProjectFiles: { readonly files: FileSearchResult[] };
  readonly thisComputer: { readonly files: FileSearchResult[] };
  readonly remoteOutsideProjects: { readonly files: FileSearchResult[] };
}

function countTierRows(group: Readonly<Record<string, readonly unknown[]>>): number {
  return Object.values(group).reduce((total, rows) => total + rows.length, 0);
}

/** Polite screen-reader summary, one clause per non-empty tier. */
export function describeSearchTiers(tiers: SearchPaletteTiers): string {
  const count = countTierRows;
  return [
    ["in this thread", count(tiers.currentThread)],
    ["in this project", count(tiers.currentProject)],
    ["elsewhere in bigbud", count(tiers.bigbudData)],
    ["in other projects", count(tiers.otherProjectFiles)],
    ["on this computer", count(tiers.thisComputer)],
    ["in remote folders outside projects", count(tiers.remoteOutsideProjects)],
  ]
    .filter(([, total]) => Number(total) > 0)
    .map(([label, total]) => `${total} ${total === 1 ? "result" : "results"} ${label}`)
    .join(", ");
}
