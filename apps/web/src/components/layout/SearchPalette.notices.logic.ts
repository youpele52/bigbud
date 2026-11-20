import {
  SYSTEM_SEARCH_LOCAL_SOURCE_ID,
  SYSTEM_SEARCH_OS_INDEX_FALLBACK_SOURCE_ID,
  type SystemSearchReason,
} from "@bigbud/contracts/search/systemSearch.ts";
import { getRemoteWorkspaceTargetLabel } from "~/components/sidebar/Sidebar.remoteWorkspaces.logic";
import { isOsIndexSource, osIndexWording } from "~/lib/osIndexWording";

import type { SystemSearchNotice } from "./SearchPalette.systemSearch.logic";

export type SearchNoticeTone = "amber" | "red";

export interface SearchNoticeText {
  readonly text: string;
  /**
   * Red for real failures, shown on their own line; amber for partial or skipped sources,
   * folded into the summary line (`summarizeSearchNotices`).
   */
  readonly tone: SearchNoticeTone;
}

/** One muted line for sources not fully searched; `details` holds each source's reason. */
export interface SearchNoticeSummaryLine {
  readonly text: string;
  readonly details: readonly string[];
}

export interface SearchNoticeSummary {
  /** Real failures, one line per distinct message. */
  readonly failures: readonly string[];
  readonly partial: SearchNoticeSummaryLine | null;
}

/** Normal state, not a problem: a remote the user has not connected is simply not searched. */
const SILENT_REASONS: ReadonlySet<SystemSearchReason> = new Set(["not-connected"]);

function isRemoteSource(sourceId: string): boolean {
  return (
    sourceId !== SYSTEM_SEARCH_LOCAL_SOURCE_ID &&
    sourceId !== SYSTEM_SEARCH_OS_INDEX_FALLBACK_SOURCE_ID &&
    !isOsIndexSource(sourceId)
  );
}

function sourceName(sourceId: string): string {
  if (sourceId === SYSTEM_SEARCH_LOCAL_SOURCE_ID) return "this computer";
  if (isOsIndexSource(sourceId) || sourceId === SYSTEM_SEARCH_OS_INDEX_FALLBACK_SOURCE_ID)
    return osIndexWording(sourceId).place;
  return getRemoteWorkspaceTargetLabel(sourceId) ?? "the remote";
}

/** Wording for a partial or unavailable `search.query` source (summary details, failures). */
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

/**
 * What the palette shows under the results (Mod+F and Mod+P): no notice for remotes that are
 * simply not connected, failures once each, and every other hint (SSH-only host, agent update,
 * busy, this-computer settings) folded into one muted "N hosts not fully searched" line whose
 * per-source reasons are the details.
 */
export function summarizeSearchNotices(
  notices: readonly SystemSearchNotice[],
): SearchNoticeSummary {
  const failures = new Set<string>();
  const details = new Set<string>();
  const partialSources = new Set<string>();
  for (const notice of notices) {
    if (SILENT_REASONS.has(notice.reason)) continue;
    const { text, tone } = describeSearchNotice(notice);
    if (tone === "red") {
      failures.add(text);
      continue;
    }
    partialSources.add(notice.sourceId);
    details.add(text);
  }
  const count = partialSources.size;
  const noun = [...partialSources].every(isRemoteSource) ? "host" : "place";
  return {
    failures: [...failures],
    partial:
      count === 0
        ? null
        : {
            text: `${count} ${noun}${count === 1 ? "" : "s"} not fully searched`,
            details: [...details],
          },
  };
}
