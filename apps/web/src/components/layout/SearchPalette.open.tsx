import type { ExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import { FolderSearchIcon } from "lucide-react";

import { openWithSystemDefault, revealInFileManager } from "~/lib/openSystemPath";
import { openPathFromChat } from "~/stores/files/filesPanel.open";

import { toastManager } from "../ui/toast";
import {
  canRevealSearchResult,
  describeSystemOpenResult,
  planSearchResultOpen,
  REMOTE_UNSUPPORTED_NOTICE,
  searchResultAbsolutePath,
  type SearchOpenNotice,
} from "./SearchPalette.open.logic";
import type { FileSearchResult } from "./SearchPalette.results";

function notify(notice: SearchOpenNotice | null): void {
  if (notice) toastManager.add(notice);
}

function hasDesktopBridge(): boolean {
  return (
    typeof window !== "undefined" && typeof window.desktopBridge?.showItemInFolder === "function"
  );
}

/** Opens a palette file row per `planSearchResultOpen`. */
export async function openSearchResult(result: FileSearchResult): Promise<void> {
  const plan = planSearchResultOpen(result);
  switch (plan.action) {
    case "in-app":
      await openPathFromChat(
        plan.target,
        plan.root,
        plan.kind,
        plan.executionTargetId as ExecutionTargetId,
      );
      return;
    case "system":
      notify(describeSystemOpenResult(await openWithSystemDefault(plan.absolutePath)));
      return;
    case "remote-unsupported":
      notify(REMOTE_UNSUPPORTED_NOTICE);
      return;
  }
}

/** "Reveal" row action; hidden for remote rows and outside the desktop app. */
export function renderSearchResultActions(result: FileSearchResult) {
  if (!canRevealSearchResult(result, hasDesktopBridge())) return null;
  const label = /mac/i.test(navigator.platform) ? "Reveal in Finder" : "Reveal in file manager";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="ml-2 rounded-md p-1 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        void revealInFileManager(searchResultAbsolutePath(result)).then((outcome) =>
          notify(describeSystemOpenResult(outcome)),
        );
      }}
    >
      <FolderSearchIcon className="size-3.5" />
    </button>
  );
}
