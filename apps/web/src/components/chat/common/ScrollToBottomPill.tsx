import { ArrowDownIcon } from "lucide-react";

import { SOLID_FLOATING_SURFACE_CLASS_NAME } from "~/components/ui/solidSurface";
import { cn } from "~/lib/utils";

interface ScrollToBottomPillProps {
  onScrollToBottom: () => void;
}

export function ScrollToBottomPill({ onScrollToBottom }: ScrollToBottomPillProps) {
  return (
    <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
      <button
        type="button"
        onClick={onScrollToBottom}
        aria-label="Scroll to bottom"
        className={cn(
          "pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-border text-foreground shadow-sm transition-all duration-150 hover:scale-105 enabled:cursor-pointer sm:h-8 sm:w-8",
          SOLID_FLOATING_SURFACE_CLASS_NAME,
        )}
      >
        <ArrowDownIcon className="size-4 sm:size-3.5" />
      </button>
    </div>
  );
}
