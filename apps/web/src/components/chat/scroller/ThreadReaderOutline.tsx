import { type MessageId } from "@bigbud/contracts";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

interface ThreadReaderOutlineProps {
  anchors: ReadonlyArray<{ messageId: MessageId; label: string }>;
  currentAnchorMessageId: MessageId | null;
  onJumpToMessage: (messageId: MessageId) => void;
  className?: string | undefined;
}

export function ThreadReaderOutline({
  anchors,
  currentAnchorMessageId,
  onJumpToMessage,
  className,
}: ThreadReaderOutlineProps) {
  if (anchors.length < 2) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Open transcript outline"
        className={cn(
          "pointer-events-auto flex flex-col items-center justify-center gap-1 rounded-md px-1 py-2 transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {anchors.map((anchor) => (
          <span
            key={anchor.messageId}
            data-current={anchor.messageId === currentAnchorMessageId}
            className="h-0.5 w-4 rounded-full bg-muted-foreground/35 data-[current=true]:bg-foreground"
          />
        ))}
      </PopoverTrigger>
      <PopoverPopup
        align="center"
        side="left"
        sideOffset={8}
        className="pointer-events-auto w-56 p-1"
      >
        {anchors.map((anchor) => {
          const isCurrent = currentAnchorMessageId === anchor.messageId;

          return (
            <button
              key={anchor.messageId}
              type="button"
              aria-current={isCurrent ? "location" : undefined}
              className={cn(
                "flex h-7 w-full items-center rounded-lg px-2 text-left text-xs transition-colors outline-none",
                isCurrent
                  ? "bg-accent/85 font-medium text-foreground hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              onClick={() => onJumpToMessage(anchor.messageId)}
            >
              <span className="line-clamp-1 min-w-0">{anchor.label}</span>
            </button>
          );
        })}
      </PopoverPopup>
    </Popover>
  );
}
