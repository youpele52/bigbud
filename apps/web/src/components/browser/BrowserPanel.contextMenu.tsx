import { memo, useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  separator?: boolean;
  onClick: () => void;
}

export interface BrowserContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const BrowserContextMenu = memo(function BrowserContextMenu({
  open,
  x,
  y,
  items,
  onClose,
}: BrowserContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={menuRef}
      className="fixed z-[60] min-w-[10rem] overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-lg"
      style={{ left: x, top: y }}
      role="menu"
    >
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={item.id}
            role="menuitem"
            type="button"
            disabled={item.disabled}
            className={cn(
              "flex w-full items-center px-3 py-2 text-left text-sm transition-colors",
              item.disabled
                ? "cursor-not-allowed text-muted-foreground/50"
                : "hover:bg-accent hover:text-accent-foreground",
            )}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
});
