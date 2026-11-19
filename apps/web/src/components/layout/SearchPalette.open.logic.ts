import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";

import { inAppViewerFor, type SystemPathOpenResult } from "~/lib/openSystemPath";

import { joinWorkspaceEntryPath } from "../files/filesPanel.dnd";
import type { FileSearchResult } from "./SearchPalette.results";

/** What selecting a palette file row does (plan §7, Q7, Q8). */
export type SearchResultOpenPlan =
  /** Existing Files or Browser panel routing (`openPathFromChat`). */
  | {
      readonly action: "in-app";
      readonly target: string;
      readonly root: string;
      readonly kind: "file" | "directory";
      readonly executionTargetId: string;
    }
  /** The desktop shell's default app; executables and bundles are revealed, never launched. */
  | { readonly action: "system"; readonly absolutePath: string }
  /** Remote file bigbud cannot show: the download-to-cache path (Q8) is not built yet. */
  | { readonly action: "remote-unsupported" };

function isLocal(result: FileSearchResult): boolean {
  return result.executionTargetId === LOCAL_EXECUTION_TARGET_ID;
}

export function searchResultAbsolutePath(result: FileSearchResult): string {
  return joinWorkspaceEntryPath(result.root, result.path);
}

/**
 * Routing for a selected row. Project files keep the existing in-app routing when bigbud can
 * show the type, and go to the system app otherwise. "This computer" rows are outside every
 * project, so they never load into bigbud panels (read-only and out of agents' reach, Q7): they
 * always go through the desktop shell, which refuses excluded paths and reveals executables.
 */
export function planSearchResultOpen(result: FileSearchResult): SearchResultOpenPlan {
  const absolutePath = searchResultAbsolutePath(result);
  const outsideProjects = result.id.startsWith("thisComputer:");
  if (outsideProjects) return { action: "system", absolutePath };
  if (result.isDirectory || inAppViewerFor(result.path) !== null) {
    const position = result.line
      ? `:${result.line}${result.column ? `:${result.column}` : ""}`
      : "";
    return {
      action: "in-app",
      target: `${absolutePath}${position}`,
      root: result.root,
      kind: result.isDirectory ? "directory" : "file",
      executionTargetId: result.executionTargetId,
    };
  }
  return isLocal(result) ? { action: "system", absolutePath } : { action: "remote-unsupported" };
}

/** "Reveal in Finder/Explorer" exists only for local rows in the desktop app. */
export function canRevealSearchResult(
  result: FileSearchResult,
  hasDesktopBridge: boolean,
): boolean {
  return hasDesktopBridge && isLocal(result);
}

export interface SearchOpenNotice {
  readonly type: "info" | "warning" | "error";
  readonly title: string;
  readonly description?: string;
}

/** Toast for a system open or reveal outcome; `null` when the action simply worked. */
export function describeSystemOpenResult(result: SystemPathOpenResult): SearchOpenNotice | null {
  switch (result.kind) {
    case "opened":
    case "revealed":
      return null;
    case "revealed-instead":
      return {
        type: "info",
        title: "Revealed instead of opened",
        description: "bigbud never runs apps, scripts or installers from search.",
      };
    case "unavailable-in-browser":
      return {
        type: "warning",
        title: "Open this file from the bigbud desktop app",
        description: "A browser cannot open apps on the computer running bigbud.",
      };
    case "refused":
      return result.reason === "inaccessible"
        ? {
            type: "warning",
            title: "bigbud will not open this file",
            description: "It cannot be accessed or is protected by bigbud's privacy exclusions.",
          }
        : {
            type: "error",
            title: "Could not open the file",
            description: result.message ?? result.reason,
          };
  }
}

export const REMOTE_UNSUPPORTED_NOTICE: SearchOpenNotice = {
  type: "warning",
  title: "This remote file type cannot open yet",
  description:
    "Opening remote files in a desktop app (download to a private cache) is coming later.",
};
