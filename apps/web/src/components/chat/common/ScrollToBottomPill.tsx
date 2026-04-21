import { ChevronDownIcon } from "lucide-react";

interface ScrollToBottomPillProps {
  onScrollToBottom: () => void;
}

export function ScrollToBottomPill({ onScrollToBottom }: ScrollToBottomPillProps) {
  return (
    <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
      <button
        type="button"
        onClick={onScrollToBottom}
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
      >
        <ChevronDownIcon className="size-3.5" />
        Scroll to bottom
      </button>
    </div>
  );
}
