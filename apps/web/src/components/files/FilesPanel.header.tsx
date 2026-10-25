import { FolderLibraryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { PinIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function FilesPanelHeader({
  treeControl,
  pinControl,
  treeVisible = false,
  pinned = false,
}: {
  readonly treeControl?: ComponentProps<typeof Button> | undefined;
  readonly pinControl?: ComponentProps<typeof Button> | undefined;
  readonly treeVisible?: boolean;
  readonly pinned?: boolean;
}) {
  const treeLabel = treeVisible ? "Hide file tree" : "Show file tree";
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
          {pinControl ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    {...pinControl}
                    className={cn(
                      pinControl.className,
                      "transition-colors",
                      pinned
                        ? "text-primary hover:text-primary/90 dark:text-primary dark:hover:text-primary/90"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    variant="toolbar"
                    size="icon-xs"
                    aria-label={pinned ? "Unpin file tree" : "Keep tree beside file"}
                    aria-pressed={pinned}
                  >
                    <PinIcon className={cn("rotate-45", pinned && "fill-current")} />
                  </Button>
                }
              />
              <TooltipPopup side="bottom">
                {pinned ? "Show tree as a drawer" : "Keep tree beside file"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  {...treeControl}
                  className={cn(
                    "shrink-0 [-webkit-app-region:no-drag]",
                    treeVisible && "bg-accent text-accent-foreground",
                  )}
                  data-files-tree-toggle
                  aria-label={treeLabel}
                  aria-pressed={treeVisible}
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
