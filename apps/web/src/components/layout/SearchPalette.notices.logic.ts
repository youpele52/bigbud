import { getRemoteWorkspaceTargetLabel } from "~/components/sidebar/Sidebar.remoteWorkspaces.logic";
import { isOsIndexSource, osIndexWording } from "~/lib/osIndexWording";

import type { SystemSearchNotice } from "./SearchPalette.systemSearch.logic";

export type SearchNoticeTone = "amber" | "red";

export interface SearchNoticeText {
  readonly text: string;
  /** Amber for partial or unavailable sources; red only for real failures. */
  readonly tone: SearchNoticeTone;
}

function sourceName(sourceId: string): string {
  if (sourceId === "local") return "this computer";
  if (isOsIndexSource(sourceId) || sourceId === "os-index") return osIndexWording(sourceId).place;
  return getRemoteWorkspaceTargetLabel(sourceId) ?? "the remote";
}

/** Palette wording for a partial or unavailable `search.query` source. */
export function describeSearchNotice(notice: SystemSearchNotice): SearchNoticeText {
  const name = sourceName(notice.sourceId);
  const index = osIndexWording(notice.sourceId);
  switch (notice.reason) {
    case "not-connected":
      return { text: `${name} is not connected; connect it to search its files.`, tone: "amber" };
    case "agent-update-available":
      return {
        text: `Showing file names only on ${name}. Update its bigbud agent to search file contents.`,
        tone: "amber",
      };
    case "use-managed-agent":
      return {
        text: `Use the bigbud agent on ${name} for faster search across its projects.`,
        tone: "amber",
      };
    case "agent-unavailable":
      return { text: "File search on this computer is unavailable right now.", tone: "amber" };
    case "busy":
      return { text: `File search on ${name} is busy; results may be incomplete.`, tone: "amber" };
    case "disabled":
      return { text: `Searching ${index.place} is turned off in Settings.`, tone: "amber" };
    case "file-access-none":
      return {
        text: `Searching ${index.place} needs File Access in Settings › AI.`,
        tone: "amber",
      };
    case "unsupported":
      return {
        text: `Searching ${index.place} is not supported on this system yet.`,
        tone: "amber",
      };
    case "policy":
      return {
        text: `Searching ${index.place} is turned off by your administrator.`,
        tone: "amber",
      };
    case "index-unavailable":
      return {
        text: `The ${index.index} index on ${index.place} is unavailable (${index.unavailableHint}).`,
        tone: "amber",
      };
    case "error":
      return { text: `File search on ${name} failed.`, tone: "red" };
  }
}
