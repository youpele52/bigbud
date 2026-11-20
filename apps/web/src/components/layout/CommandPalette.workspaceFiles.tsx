import type { ExecutionTargetId } from "@bigbud/contracts";
import { isRemoteExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import type { ProjectEntry } from "@bigbud/contracts/workspace/project.ts";
import { FileIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { workspaceErrorMessage } from "../../lib/workspaceRequestRecovery.errors";
import { WorkspaceRequestStatus } from "../common/WorkspaceRequestStatus";
import { useWorkspaceFileSearch } from "./useWorkspaceFileSearch";
import { CommandGroup, CommandGroupLabel, CommandItem } from "../ui/command";
import { openSearchResult, renderSearchResultActions } from "./SearchPalette.open";
import type { FileSearchResult } from "./SearchPalette.results";
import { SearchPaletteSeeMore } from "./SearchPalette.section";

const INITIAL_VISIBLE_FILE_COUNT = 10;
/** Server pages of the in-memory list: the first answer, then larger ones when scrolled to. */
export const FILE_SEARCH_PAGE_LIMITS = [80, 160, 200] as const;

interface CommandPaletteWorkspaceFilesProps {
  open: boolean;
  normalizedQuery: string;
  workspaceRoot: string | null;
  workspaceExecutionTargetId?: ExecutionTargetId | null | undefined;
  onBeforeOpenFile: () => void;
  withTopMargin?: boolean;
}

/** A current-project entry as a palette row, so it opens like every other file row. */
function toResult(root: string, target: string, entry: ProjectEntry): FileSearchResult {
  const base = root.endsWith("/") ? root : `${root}/`;
  return {
    id: `currentProject:name:${target}:${base}${entry.path}`,
    kind: "name",
    executionTargetId: target as ExecutionTargetId,
    root,
    path: entry.path,
    isDirectory: entry.kind === "directory",
  };
}

/**
 * Mod+P tier 1: the current project's in-memory file list (`projects.searchEntries`), the first
 * and instant source; nothing else is awaited before it renders. Rows open through the Phase 4
 * routing (in-app viewer, otherwise the system app; executables revealed only).
 */
export function CommandPaletteWorkspaceFiles({
  open,
  normalizedQuery,
  workspaceRoot,
  workspaceExecutionTargetId,
  onBeforeOpenFile,
  withTopMargin,
}: CommandPaletteWorkspaceFilesProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_FILE_COUNT);
  const [pageIndex, setPageIndex] = useState(0);
  const listKey = JSON.stringify([
    normalizedQuery,
    open,
    workspaceRoot,
    workspaceExecutionTargetId,
  ]);

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_FILE_COUNT);
    setPageIndex(0);
  }, [listKey]);

  const workspaceEntriesQuery = useWorkspaceFileSearch({
    cwd: workspaceRoot,
    executionTargetId: workspaceExecutionTargetId,
    query: normalizedQuery,
    enabled: open && normalizedQuery.length > 0,
    limit: FILE_SEARCH_PAGE_LIMITS[pageIndex] ?? FILE_SEARCH_PAGE_LIMITS[0],
  });

  // While a larger page loads, keep showing the rows of the smaller one for the same list.
  const shown = useRef<{ key: string; entries: readonly ProjectEntry[]; truncated: boolean }>({
    key: "",
    entries: [],
    truncated: false,
  });
  const data = workspaceEntriesQuery.data;
  if (data) shown.current = { key: listKey, entries: data.entries, truncated: data.truncated };
  const current = shown.current.key === listKey ? shown.current : null;

  const fileEntries = useMemo(
    () => (current?.entries ?? []).filter((entry) => entry.kind === "file"),
    [current?.entries],
  );

  const visibleEntries = fileEntries.slice(0, visibleCount);
  const hiddenCount = fileEntries.length - visibleEntries.length;
  const nextPage = pageIndex + 1 < FILE_SEARCH_PAGE_LIMITS.length ? pageIndex + 1 : null;
  const hasMorePages = hiddenCount === 0 && current?.truncated === true && nextPage !== null;

  const loading = workspaceEntriesQuery.isFetching && !current;
  const error =
    !workspaceEntriesQuery.isFetching && workspaceEntriesQuery.isError
      ? workspaceErrorMessage(workspaceEntriesQuery.error)
      : null;
  const remote = isRemoteExecutionTargetId(workspaceExecutionTargetId);
  const target = workspaceExecutionTargetId ?? "local";
  const openFile = (entry: ProjectEntry) => {
    onBeforeOpenFile();
    void openSearchResult(toResult(workspaceRoot!, target, entry)).catch((cause) =>
      console.error("Failed to open file:", cause),
    );
  };

  if (!open || normalizedQuery.length === 0 || !workspaceRoot) {
    return null;
  }

  return (
    <CommandGroup className={withTopMargin ? "mt-2" : undefined}>
      <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
        Files
      </CommandGroupLabel>
      {loading || error ? (
        <WorkspaceRequestStatus
          error={error}
          recovering={remote && workspaceEntriesQuery.recovering}
          pending={workspaceEntriesQuery.requestPending}
          onRetry={() => void workspaceEntriesQuery.refetch()}
        />
      ) : current && fileEntries.length === 0 ? (
        <div className="px-2 py-3 text-xs text-muted-foreground" role="status">
          No matching files.
        </div>
      ) : null}
      {visibleEntries.map((entry) => (
        <CommandItem
          key={entry.path}
          value={entry.path.toLowerCase()}
          className="min-h-11 rounded-xl px-3 py-2"
          onSelect={() => openFile(entry)}
          onClick={() => openFile(entry)}
        >
          <div className="mr-3 text-muted-foreground/70">
            <FileIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{entry.path.split("/").at(-1) ?? entry.path}</div>
            <div className="truncate text-muted-foreground text-xs leading-5">{entry.path}</div>
          </div>
          {renderSearchResultActions(toResult(workspaceRoot, target, entry))}
        </CommandItem>
      ))}
      {hiddenCount > 0 ? (
        <SearchPaletteSeeMore
          remaining={hiddenCount}
          onClick={() => setVisibleCount((count) => count + INITIAL_VISIBLE_FILE_COUNT)}
        />
      ) : hasMorePages ? (
        <SearchPaletteSeeMore
          onClick={() => {
            setPageIndex(nextPage);
            setVisibleCount((count) => count + INITIAL_VISIBLE_FILE_COUNT);
          }}
        />
      ) : null}
    </CommandGroup>
  );
}
