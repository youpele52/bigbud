import { PinIcon, SplitIcon } from "lucide-react";
import { type MouseEvent } from "react";
import type { ThreadId } from "@bigbud/contracts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadRowActionsProps {
  threadId: ThreadId;
  threadTitle: string;
  swipeRevealIsRevealed: boolean;
  isFavorite: boolean;
  handleForkAction: (event: MouseEvent<HTMLButtonElement>) => void;
  handleFavoriteAction: (event: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * Action buttons displayed on hover/focus for a sidebar thread row.
 * Contains fork and pin buttons with appropriate tooltips.
 */
export function SidebarThreadRowActions({
  threadId,
  threadTitle,
  swipeRevealIsRevealed,
  isFavorite,
  handleForkAction,
  handleFavoriteAction,
}: SidebarThreadRowActionsProps) {
  return (
    <div
      className={`pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 flex-row gap-0.5 transition-opacity duration-150 ${
        swipeRevealIsRevealed
          ? "opacity-0"
          : "opacity-100 md:opacity-0 md:group-hover/menu-sub-item:pointer-events-auto md:group-hover/menu-sub-item:opacity-100 md:group-focus-within/menu-sub-item:pointer-events-auto md:group-focus-within/menu-sub-item:opacity-100"
      }`}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-thread-selection-safe
              data-testid={`thread-fork-${threadId}`}
              aria-label={`Fork ${threadTitle}`}
              className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={handleForkAction}
            >
              <SplitIcon className="size-3.5" />
            </button>
          }
        />
        <TooltipPopup side="top">Fork thread</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-thread-selection-safe
              data-testid={`thread-favorite-${threadId}`}
              aria-label={`${isFavorite ? "Unpin" : "Pin"} ${threadTitle}`}
              className={`inline-flex size-5 cursor-pointer items-center justify-center transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${
                isFavorite
                  ? "text-primary hover:text-primary/90"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={handleFavoriteAction}
            >
              <PinIcon className={`size-3.5 ${isFavorite ? "fill-current" : ""}`} />
            </button>
          }
        />
        <TooltipPopup side="top">{isFavorite ? "Unpin thread" : "Pin thread"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
