import { ArrowDownIcon } from "lucide-react";

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
        className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm transition-all duration-150 hover:scale-105 hover:bg-muted enabled:cursor-pointer sm:h-8 sm:w-8"
      >
        <ArrowDownIcon className="size-4 sm:size-3.5" />
      </button>
    </div>
  );
}
