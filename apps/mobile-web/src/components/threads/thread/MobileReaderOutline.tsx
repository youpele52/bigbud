import { type MessageId } from "@bigbud/contracts";
import { useEffect, useRef, useState } from "react";

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
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  if (anchors.length < 2) {
    return null;
  }

  return (
    <div ref={menuRef} className="pointer-events-auto relative">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Open transcript outline"
        className="flex flex-col items-center justify-center gap-1 rounded-md px-1 py-2 outline-none transition-colors active:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {anchors.map((anchor) => (
          <span
            key={anchor.messageId}
            className="h-0.5 w-4 rounded-full bg-muted-foreground/35 data-[current=true]:bg-foreground"
            data-current={anchor.messageId === currentAnchorMessageId}
          />
        ))}
      </button>
      {open ? (
        <div
          className="absolute top-1/2 right-full z-50 mr-2 max-h-[50dvh] w-56 -translate-y-1/2 overflow-y-auto overscroll-y-contain rounded-xl border border-border bg-popover p-1.5 shadow-lg"
          role="menu"
        >
          {anchors.map((anchor) => {
            const isCurrent = anchor.messageId === currentAnchorMessageId;
            return (
              <button
                key={anchor.messageId}
                aria-current={isCurrent ? "location" : undefined}
                className={cn(
                  "block h-8 w-full rounded-lg px-2 text-left text-xs transition-colors",
                  isCurrent
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground active:bg-accent active:text-foreground",
                )}
                onClick={() => {
                  setOpen(false);
                  onJumpToMessage(anchor.messageId);
                }}
                role="menuitem"
                type="button"
              >
                <span className="line-clamp-1">{anchor.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
