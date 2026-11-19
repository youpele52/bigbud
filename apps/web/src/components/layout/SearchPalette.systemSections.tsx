import { Fragment } from "react";

import { cn } from "~/lib/utils";

import { FileSearchResultGroup } from "./SearchPalette.fileResults";
import { describeSearchNotice } from "./SearchPalette.notices.logic";
import type { FileSearchResult } from "./SearchPalette.results";
import type { SystemSearchNotice } from "./SearchPalette.systemSearch.logic";
import type { SearchPaletteTiers } from "./SearchPalette.tiers.logic";
import type { SectionVisibility } from "./SearchPalette.visibility";

export interface SearchPaletteSystemSectionsProps {
  tiers: Pick<SearchPaletteTiers, "otherProjectFiles" | "thisComputer" | "remoteOutsideProjects">;
  notices: readonly SystemSearchNotice[];
  visibility: SectionVisibility;
  onSelectFile: (result: FileSearchResult) => void;
  renderFileActions?: (result: FileSearchResult) => React.ReactNode;
  /** The one-time "Search this computer" hint, shown where T5 rows would be. */
  thisComputerHint?: React.ReactNode;
}

/** Notices for partial or unavailable sources (not connected, agent update, SSH-only, ...). */
export function SearchPaletteNotices({ notices }: { notices: readonly SystemSearchNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="px-4 py-1">
      {notices.map((notice) => {
        const { text, tone } = describeSearchNotice(notice);
        return (
          <div
            key={`${notice.sourceId}:${notice.reason}`}
            className={cn("py-0.5 text-xs", tone === "red" ? "text-destructive" : "text-amber-600")}
          >
            {text}
          </div>
        );
      })}
    </div>
  );
}

/** T4 other projects' files, T5 this computer, T6 remote folders outside projects, in order. */
export function SearchPaletteSystemSections(props: SearchPaletteSystemSectionsProps) {
  const { tiers, visibility } = props;
  const sections = [
    ["t4.files", "Files in other projects", tiers.otherProjectFiles.files],
    ["t5.files", "This computer", tiers.thisComputer.files],
    ["t6.files", "Remote folders outside projects", tiers.remoteOutsideProjects.files],
  ] as const;
  return (
    <>
      {sections.map(([id, label, files]) => (
        <Fragment key={id}>
          <FileSearchResultGroup
            label={label}
            results={files}
            visibleResults={visibility.slice(id, files)}
            showLabel
            onSelect={props.onSelectFile}
            onShowMore={() => visibility.showMore(id)}
            {...(props.renderFileActions ? { renderActions: props.renderFileActions } : {})}
          />
          {id === "t5.files" ? props.thisComputerHint : null}
        </Fragment>
      ))}
      <SearchPaletteNotices notices={props.notices} />
    </>
  );
}
