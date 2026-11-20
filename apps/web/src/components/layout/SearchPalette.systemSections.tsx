import type { SystemSearchTier } from "@bigbud/contracts/search/systemSearch.ts";
import { Fragment } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { FileSearchResultGroup } from "./SearchPalette.fileResults";
import { summarizeSearchNotices } from "./SearchPalette.notices.logic";
import type { FileSearchResult } from "./SearchPalette.results";
import type { SystemSearchNotice } from "./SearchPalette.systemSearch.logic";
import type { SearchPaletteTiers } from "./SearchPalette.tiers.logic";
import type { SectionVisibility } from "./SearchPalette.visibility";

/** Next pages of streamed tiers (`useSystemSearchStream`), loaded when scrolled to. */
export interface SystemSearchPaging {
  readonly hasMore: (tier: SystemSearchTier) => boolean;
  readonly loadMore: (tier: SystemSearchTier) => void;
}

export interface SearchPaletteSystemSectionsProps {
  tiers: Pick<SearchPaletteTiers, "otherProjectFiles" | "thisComputer" | "remoteOutsideProjects">;
  notices: readonly SystemSearchNotice[];
  visibility: SectionVisibility;
  onSelectFile: (result: FileSearchResult) => void;
  renderFileActions?: (result: FileSearchResult) => React.ReactNode;
  /** The one-time "Search this computer" hint, shown where T5 rows would be. */
  thisComputerHint?: React.ReactNode;
  paging?: SystemSearchPaging;
  /** A freshness caveat for T5 rows (Linux `locate`), shown under them. */
  thisComputerNote?: string | null;
  /** Section headings; Mod+P words them for file names. */
  labels?: Readonly<Record<"t4.files" | "t5.files" | "t6.files", string>>;
}

const DEFAULT_LABELS = {
  "t4.files": "Files in other projects",
  "t5.files": "This computer",
  "t6.files": "Remote folders outside projects",
} as const;

/**
 * Under the results: real failures once each, then at most one muted summary of sources not
 * fully searched, with each source's reason in its tooltip (and for screen readers). Remotes
 * that are simply not connected get no notice.
 */
export function SearchPaletteNotices({ notices }: { notices: readonly SystemSearchNotice[] }) {
  const { failures, partial } = summarizeSearchNotices(notices);
  if (failures.length === 0 && !partial) return null;
  return (
    <div className="px-4 py-1 text-xs">
      {failures.map((failure) => (
        <div key={failure} className="py-0.5 text-destructive">
          {failure}
        </div>
      ))}
      {partial ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="w-fit cursor-default rounded-sm py-0.5 text-left text-muted-foreground underline decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
              />
            }
          >
            {partial.text}
            <span className="sr-only">: {partial.details.join(" ")}</span>
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-80 whitespace-normal text-xs leading-snug">
            {partial.details.map((detail) => (
              <div key={detail}>{detail}</div>
            ))}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** T4 other projects' files, T5 this computer, T6 remote folders outside projects, in order. */
export function SearchPaletteSystemSections(props: SearchPaletteSystemSectionsProps) {
  const { tiers, visibility, paging } = props;
  const labels = props.labels ?? DEFAULT_LABELS;
  const sections = [
    ["t4.files", "otherProjectFiles", tiers.otherProjectFiles.files],
    ["t5.files", "thisComputer", tiers.thisComputer.files],
    ["t6.files", "remoteOutsideProjects", tiers.remoteOutsideProjects.files],
  ] as const;
  return (
    <>
      {sections.map(([id, tier, files]) => (
        <Fragment key={id}>
          <FileSearchResultGroup
            label={labels[id]}
            results={files}
            visibleResults={visibility.slice(id, files)}
            showLabel
            onSelect={props.onSelectFile}
            onShowMore={() => visibility.showMore(id)}
            hasMorePages={paging?.hasMore(tier) ?? false}
            onLoadMorePages={() => {
              paging?.loadMore(tier);
              visibility.showMore(id);
            }}
            {...(props.renderFileActions ? { renderActions: props.renderFileActions } : {})}
          />
          {id === "t5.files" && props.thisComputerNote && files.length > 0 ? (
            <div className="px-4 py-1 text-xs text-muted-foreground">{props.thisComputerNote}</div>
          ) : null}
          {id === "t5.files" ? props.thisComputerHint : null}
        </Fragment>
      ))}
      <SearchPaletteNotices notices={props.notices} />
    </>
  );
}
