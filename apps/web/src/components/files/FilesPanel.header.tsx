import { FolderLibraryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";

import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function FilesPanelHeader({
  treeControl,
  keptOpen = false,
}: {
  readonly treeControl?: ComponentProps<typeof Button> | undefined;
  readonly keptOpen?: boolean;
}) {
  const treeLabel = keptOpen ? "Close file tree" : "Keep file tree open";
  return (
    <div
      data-files-panel-header
      className={cn(
        "flex h-11 shrink-0 items-center justify-between border-b border-border px-3",
        isElectron && "drag-region",
      )}
    >
      <p className="text-sm font-medium text-foreground">Files</p>
      {treeControl ? (
        <div
          className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
          data-files-panel-controls
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  {...treeControl}
                  className={cn(
                    "shrink-0 [-webkit-app-region:no-drag]",
                    keptOpen && "bg-accent text-accent-foreground",
                  )}
                  data-files-tree-toggle
                  aria-label={treeLabel}
                  aria-pressed={keptOpen}
                  variant="toolbar"
                  size="icon-xs"
                >
                  <HugeiconsIcon
                    icon={FolderLibraryIcon}
                    size={16}
                    strokeWidth={1.5}
                    className="size-4"
                    aria-hidden="true"
                  />
                </Button>
              }
            />
            <TooltipPopup side="bottom">{treeLabel}</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
