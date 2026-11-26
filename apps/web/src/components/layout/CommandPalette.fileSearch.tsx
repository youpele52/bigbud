import type { ExecutionTargetId, ProjectId, ThreadId } from "@bigbud/contracts";
import { isRemoteExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";

import { useSettings } from "../../hooks/useSettings";
import { CommandPaletteWorkspaceFiles } from "./CommandPalette.workspaceFiles";
import { FileSearchResultGroup } from "./SearchPalette.fileResults";
import { openSearchResult, renderSearchResultActions } from "./SearchPalette.open";
import type { FileSearchResult } from "./SearchPalette.results";
import { useSlowTierQuery, useSystemSearchStream } from "./SearchPalette.stream";
import {
  isSystemSearchTierPending,
  isThisComputerSearchOn,
  systemSearchNotices,
  systemSearchTierRows,
  thisComputerNote,
} from "./SearchPalette.systemSearch.logic";
import { SearchPaletteSystemSections } from "./SearchPalette.systemSections";
import { useOpenedFileRank } from "./SearchPalette.frecency";
import { SearchPaletteThisComputerHint } from "./SearchPalette.thisComputerHint";
import { useSectionVisibility } from "./SearchPalette.visibility";

const PAGE_SIZE = 10;
const MOD_P_LABELS = {
  "t4.files": "Files in other projects",
  "t5.files": "Files on this computer",
  "t6.files": "Files in remote folders",
} as const;

export interface CommandPaletteFileSearchProps {
  open: boolean;
  normalizedQuery: string;
  workspaceRoot: string | null;
  workspaceExecutionTargetId?: ExecutionTargetId | null | undefined;
  currentProjectId: ProjectId | null;
  currentThreadId: ThreadId | null;
  onBeforeOpenFile: () => void;
  withTopMargin?: boolean;
}

/**
 * Mod+P "find a file by name" across every source, in fixed order: (1) the current project,
 * (2) other projects, local then remote, (3) this computer through the OS index, (4) remote
 * folders outside projects. A local current project answers at once from its in-memory list;
 * everything else is one `search.query` in `fileNames` mode, started 150 ms after typing stops,
 * cancelled when superseded, and limited to remotes that are already connected.
 */
export function CommandPaletteFileSearch(props: CommandPaletteFileSearchProps) {
  const { open, normalizedQuery } = props;
  const remoteCurrent = isRemoteExecutionTargetId(props.workspaceExecutionTargetId);
  const thisComputer = useSettings(isThisComputerSearchOn);
  const streamQuery = useSlowTierQuery(normalizedQuery).query;
  const stream = useSystemSearchStream({
    open,
    query: streamQuery,
    currentProjectId: props.currentProjectId,
    currentThreadId: props.currentThreadId,
    thisComputer,
    // A remote current project is searched by its agent, so it never dials (see tier 1 below).
    currentProject: remoteCurrent,
    mode: "fileNames",
  });
  const visibility = useSectionVisibility(`${open}:${streamQuery}`, PAGE_SIZE);
  const view = stream.view;
  const openedRank = useOpenedFileRank();
  const tiers = {
    otherProjectFiles: { files: systemSearchTierRows(view, "otherProjectFiles", openedRank) },
    thisComputer: { files: systemSearchTierRows(view, "thisComputer", openedRank) },
    remoteOutsideProjects: {
      files: systemSearchTierRows(view, "remoteOutsideProjects", openedRank),
    },
  };
  const remoteCurrentRows = systemSearchTierRows(view, "currentProject", openedRank);
  const select = (result: FileSearchResult) => {
    props.onBeforeOpenFile();
    void openSearchResult(result).catch((cause) => console.error("Failed to open file:", cause));
  };
  if (!open || normalizedQuery.length === 0) return null;

  return (
    <div className={props.withTopMargin ? "mt-2" : undefined} data-testid="mod-p-file-search">
      {remoteCurrent ? (
        <>
          <FileSearchResultGroup
            label="Files"
            results={remoteCurrentRows}
            visibleResults={visibility.slice("t2.files", remoteCurrentRows)}
            onSelect={select}
            onShowMore={() => visibility.showMore("t2.files")}
            hasMorePages={stream.hasMore("currentProject")}
            onLoadMorePages={() => {
              stream.loadMore("currentProject");
              visibility.showMore("t2.files");
            }}
            renderActions={renderSearchResultActions}
          />
          {isSystemSearchTierPending(view, "currentProject") && remoteCurrentRows.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground" role="status">
              Searching files…
            </div>
          ) : null}
        </>
      ) : (
        <CommandPaletteWorkspaceFiles
          open={open}
          normalizedQuery={normalizedQuery}
          workspaceRoot={props.workspaceRoot}
          workspaceExecutionTargetId={props.workspaceExecutionTargetId}
          onBeforeOpenFile={props.onBeforeOpenFile}
        />
      )}
      <SearchPaletteSystemSections
        tiers={tiers}
        notices={systemSearchNotices(view)}
        visibility={visibility}
        onSelectFile={select}
        renderFileActions={renderSearchResultActions}
        paging={stream}
        labels={MOD_P_LABELS}
        thisComputerNote={thisComputerNote(view)}
        thisComputerHint={
          <SearchPaletteThisComputerHint query={streamQuery} onNavigate={props.onBeforeOpenFile} />
        }
      />
    </div>
  );
}
