import type { MessageId, ThreadId } from "@bigbud/contracts";
import {
  CONVERSATION_SEARCH_MAX_QUERY_LENGTH,
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
} from "@bigbud/contracts/orchestration/orchestration.search";
import { countUnicodeCodePoints } from "@bigbud/shared/String";

import { SearchPaletteCurrentFileResults } from "./SearchPalette.currentFileResults";
import { FileSearchResultGroup } from "./SearchPalette.fileResults";
import type { FileSearchMatch } from "./SearchPalette.logic";
import { SearchPaletteMessageResults } from "./SearchPalette.messageResults";
import { ProjectSearchResultGroup, type ProjectSearchResult } from "./SearchPalette.projectResults";
import type { FileSearchResult } from "./SearchPalette.results";
import type { SectionVisibility } from "./SearchPalette.visibility";
import { TerminalSearchResultGroup } from "./SearchPalette.terminalResults";
import type { TerminalSearchResult } from "./SearchPalette.terminalResults.logic";
import {
  SearchPaletteSystemSections,
  type SystemSearchPaging,
} from "./SearchPalette.systemSections";
import type { SystemSearchNotice } from "./SearchPalette.systemSearch.logic";
import { ThreadSearchResultGroup } from "./SearchPalette.threadResults";
import { describeSearchTiers, type SearchPaletteTiers } from "./SearchPalette.tiers.logic";

export interface SearchPalettePendingState {
  /** The slow-tier debounce (T4–T6) has not fired yet. */
  readonly debounce: boolean;
  readonly messages: boolean;
  readonly files: boolean;
  readonly projects: boolean;
  readonly terminals: boolean;
}

export interface SearchPaletteTierSectionsProps {
  query: string;
  normalizedQuery: string;
  tiers: SearchPaletteTiers;
  pending: SearchPalettePendingState;
  messageSearchStatus?: "ready" | "stale" | "unavailable" | undefined;
  /** Partial or unavailable `search.query` sources (not connected, agent update, ...). */
  systemNotices?: readonly SystemSearchNotice[];
  renderFileActions?: (result: FileSearchResult) => React.ReactNode;
  thisComputerHint?: React.ReactNode;
  /** Next pages of streamed file tiers, loaded when a tier's "See more" is scrolled to. */
  systemPaging?: SystemSearchPaging;
  thisComputerNote?: string | null;
  currentFile: {
    path: string | null;
    matches: readonly FileSearchMatch[];
    onSelect: (line: number) => void;
  };
  visibility: SectionVisibility;
  hasMoreMessagePages: boolean;
  onShowMoreMessages: (visibleCount: number) => void;
  onSelectMessage: (threadId: ThreadId, messageId: MessageId) => void;
  onSelectThread: (threadId: ThreadId) => void;
  onSelectProject: (result: ProjectSearchResult) => void;
  onSelectFile: (result: FileSearchResult) => void;
  onSelectTerminal: (result: TerminalSearchResult) => void;
}

/**
 * Sections in fixed tier order: T1 current thread, T2 current project, T3 other bigbud data, T4
 * other projects' files, T5 this computer, T6 remote folders outside projects. T1–T3 render as
 * soon as they answer; T4–T6 start after the slow-tier debounce, and streamed file rows append as
 * they arrive.
 */
export function SearchPaletteTierSections(props: SearchPaletteTierSectionsProps) {
  const { query, tiers, pending, visibility, currentFile } = props;
  const { slice, showMore } = visibility;
  // Length hints wait for typing to pause, so they do not flash while a word is typed.
  const typingPaused = !pending.debounce;
  const anyPending =
    pending.debounce || pending.messages || pending.files || pending.projects || pending.terminals;
  const summary = describeSearchTiers(tiers);
  const queryLength = countUnicodeCodePoints(query.trim());
  const otherMessages = slice("t3.messages", tiers.bigbudData.messages);

  return (
    <>
      <div aria-live="polite" className="sr-only">
        {anyPending ? "" : summary}
      </div>
      {currentFile.path ? (
        <SearchPaletteCurrentFileResults
          path={currentFile.path}
          query={query}
          matches={currentFile.matches}
          visibleMatches={slice("t1.currentFile", currentFile.matches)}
          onSelect={currentFile.onSelect}
          onShowMore={() => showMore("t1.currentFile")}
        />
      ) : null}
      {anyPending && props.normalizedQuery ? (
        <div className="px-4 py-8 text-center text-muted-foreground text-sm">Searching...</div>
      ) : null}
      {typingPaused && queryLength < CONVERSATION_SEARCH_MIN_QUERY_LENGTH ? (
        <div className="px-4 py-2 text-xs text-muted-foreground">
          Enter at least 3 characters to search saved messages.
        </div>
      ) : null}
      {typingPaused && queryLength > CONVERSATION_SEARCH_MAX_QUERY_LENGTH ? (
        <div className="px-4 py-2 text-xs text-muted-foreground">
          Shorten your query to 160 characters to search saved messages.
        </div>
      ) : null}
      {props.messageSearchStatus === "stale" ? (
        <div className="px-4 py-2 text-xs text-amber-600">
          Saved messages are still catching up.
        </div>
      ) : null}
      {props.messageSearchStatus === "unavailable" ? (
        <div className="px-4 py-2 text-xs text-amber-600">
          Saved message search is temporarily unavailable.
        </div>
      ) : null}
      {!anyPending &&
      props.messageSearchStatus !== "unavailable" &&
      !currentFile.path &&
      props.normalizedQuery &&
      summary === "" ? (
        <div className="px-4 py-8 text-center text-muted-foreground text-sm">
          No matching results
        </div>
      ) : null}

      <SearchPaletteMessageResults
        label="In this thread"
        query={query}
        results={tiers.currentThread.messages}
        visibleResults={slice("t1.messages", tiers.currentThread.messages)}
        showLocation={false}
        onSelect={props.onSelectMessage}
        onShowMore={() => showMore("t1.messages")}
      />
      <TerminalSearchResultGroup
        label="Terminals in this thread"
        query={query}
        results={tiers.currentThread.terminals}
        visibleResults={slice("t1.terminals", tiers.currentThread.terminals)}
        onSelect={props.onSelectTerminal}
        onShowMore={() => showMore("t1.terminals")}
      />
      <SearchPaletteMessageResults
        label="In this project"
        query={query}
        results={tiers.currentProject.messages}
        visibleResults={slice("t2.messages", tiers.currentProject.messages)}
        showLocation
        onSelect={props.onSelectMessage}
        onShowMore={() => showMore("t2.messages")}
      />
      <ThreadSearchResultGroup
        label="Threads in this project"
        results={tiers.currentProject.threads}
        visibleResults={slice("t2.threads", tiers.currentProject.threads)}
        onSelect={props.onSelectThread}
        onShowMore={() => showMore("t2.threads")}
      />
      <FileSearchResultGroup
        label="Files in this project"
        results={tiers.currentProject.files}
        visibleResults={slice("t2.files", tiers.currentProject.files)}
        onSelect={props.onSelectFile}
        onShowMore={() => showMore("t2.files")}
        hasMorePages={props.systemPaging?.hasMore("currentProject") ?? false}
        onLoadMorePages={() => {
          props.systemPaging?.loadMore("currentProject");
          showMore("t2.files");
        }}
        {...(props.renderFileActions ? { renderActions: props.renderFileActions } : {})}
      />
      <SearchPaletteMessageResults
        label="Messages in other threads"
        query={query}
        results={tiers.bigbudData.messages}
        visibleResults={otherMessages}
        showLocation
        hasMorePages={props.hasMoreMessagePages}
        onSelect={props.onSelectMessage}
        onShowMore={() => {
          props.onShowMoreMessages(otherMessages.length);
          showMore("t3.messages");
        }}
      />
      <ThreadSearchResultGroup
        label="All threads"
        results={tiers.bigbudData.threads}
        visibleResults={slice("t3.threads", tiers.bigbudData.threads)}
        onSelect={props.onSelectThread}
        onShowMore={() => showMore("t3.threads")}
      />
      {!pending.projects ? (
        <ProjectSearchResultGroup
          query={query}
          results={tiers.bigbudData.projects}
          visibleResults={slice("t3.projects", tiers.bigbudData.projects)}
          onSelect={props.onSelectProject}
          onShowMore={() => showMore("t3.projects")}
        />
      ) : null}
      {!pending.terminals ? (
        <TerminalSearchResultGroup
          query={query}
          results={tiers.bigbudData.terminals}
          visibleResults={slice("t3.terminals", tiers.bigbudData.terminals)}
          onSelect={props.onSelectTerminal}
          onShowMore={() => showMore("t3.terminals")}
        />
      ) : null}
      <SearchPaletteSystemSections
        tiers={tiers}
        notices={props.systemNotices ?? []}
        visibility={visibility}
        onSelectFile={props.onSelectFile}
        {...(props.renderFileActions ? { renderFileActions: props.renderFileActions } : {})}
        thisComputerHint={props.thisComputerHint}
        {...(props.systemPaging ? { paging: props.systemPaging } : {})}
        thisComputerNote={props.thisComputerNote ?? null}
      />
    </>
  );
}
