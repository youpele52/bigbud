import { type MessageId } from "@bigbud/contracts";

import { cn } from "~/lib/utils";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";

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
    <Menu>
      <MenuTrigger
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
      </MenuTrigger>
      <MenuPopup
        align="center"
        side="left"
        sideOffset={8}
        className="pointer-events-auto w-56 overflow-hidden p-0 [&>div]:max-h-[50dvh] [&>div]:overflow-y-auto [&>div]:overscroll-y-contain [&>div]:px-1 [&>div]:py-2 [&>div]:[scrollbar-gutter:stable]"
      >
        {anchors.map((anchor) => {
          const isCurrent = currentAnchorMessageId === anchor.messageId;

          return (
            <MenuItem
              key={anchor.messageId}
              aria-current={isCurrent ? "location" : undefined}
              className={cn(
                "h-7 min-h-7 cursor-pointer rounded-lg px-2 text-xs sm:min-h-7 sm:text-xs",
                isCurrent
                  ? "bg-accent/85 font-medium text-foreground hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              onClick={() => onJumpToMessage(anchor.messageId)}
            >
              <span className="line-clamp-1 min-w-0">{anchor.label}</span>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}
