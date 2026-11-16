import { Menu } from "@base-ui/react/menu";
import { type MessageId } from "@bigbud/contracts";

import { cn } from "../../../lib/cn";

interface MobileReaderOutlineProps {
  anchors: ReadonlyArray<{ messageId: MessageId; label: string }>;
  currentAnchorMessageId: MessageId | null;
  onJumpToMessage: (messageId: MessageId) => void;
}

export function MobileReaderOutline({
  anchors,
  currentAnchorMessageId,
  onJumpToMessage,
}: MobileReaderOutlineProps) {
  if (anchors.length < 2) return null;

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label="Open transcript outline"
        className="pointer-events-auto flex min-h-11 min-w-11 flex-col items-end justify-center gap-px rounded-md px-1 py-1 outline-none transition-colors active:bg-accent/25 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {anchors.map((anchor) => (
          <span
            key={anchor.messageId}
            className="h-0.5 w-3 rounded-full bg-muted-foreground/28 data-[current=true]:bg-foreground"
            data-current={anchor.messageId === currentAnchorMessageId}
          />
        ))}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="left"
          align="center"
          sideOffset={12}
          collisionPadding={8}
          className="z-50"
        >
          <Menu.Popup className="max-h-[min(calc(var(--mobile-viewport-height,100dvh)*0.5),var(--available-height))] w-56 overflow-y-auto overscroll-y-contain rounded-xl border border-border/70 bg-background/96 p-1.5 text-foreground shadow-lg shadow-black/10 outline-none backdrop-blur-sm dark:border-border/60 dark:bg-background/92">
            {anchors.map((anchor) => {
              const isCurrent = anchor.messageId === currentAnchorMessageId;
              return (
                <Menu.Item
                  key={anchor.messageId}
                  aria-current={isCurrent ? "location" : undefined}
                  label={anchor.label}
                  className={cn(
                    "flex min-h-11 w-full items-center rounded-lg px-2 text-left text-sm outline-none transition-colors data-highlighted:bg-accent data-highlighted:text-foreground",
                    isCurrent
                      ? "bg-accent/85 font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                  onClick={() => onJumpToMessage(anchor.messageId)}
                >
                  <span className="line-clamp-2">{anchor.label}</span>
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
