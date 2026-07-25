import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "~/lib/utils";

import type { BrowserContextMenuAnchor } from "./BrowserPanel.contextMenu.hook";

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  separator?: boolean;
  onClick: () => void;
}

export interface BrowserContextMenuProps {
  anchor: BrowserContextMenuAnchor | null;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const BrowserContextMenu = memo(function BrowserContextMenu({
  anchor,
  items,
  onClose,
}: BrowserContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const open = anchor !== null;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const boundary = menu?.offsetParent;
    if (!menu || !(boundary instanceof HTMLElement) || !anchor) return;

    const positionMenu = () => {
      const inset = 4;
      const left =
        anchor.kind === "center" ? (boundary.clientWidth - menu.offsetWidth) / 2 : anchor.x;
      const top =
        anchor.kind === "center" ? (boundary.clientHeight - menu.offsetHeight) / 2 : anchor.y;
      const maximumLeft = Math.max(inset, boundary.clientWidth - menu.offsetWidth - inset);
      const maximumTop = Math.max(inset, boundary.clientHeight - menu.offsetHeight - inset);

      menu.style.left = `${Math.min(Math.max(inset, left), maximumLeft)}px`;
      menu.style.top = `${Math.min(Math.max(inset, top), maximumTop)}px`;
    };

    positionMenu();
    const resizeObserver = new ResizeObserver(positionMenu);
    resizeObserver.observe(boundary);
    resizeObserver.observe(menu);
    return () => resizeObserver.disconnect();
  }, [anchor]);

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

  if (!anchor) return null;

  return (
    <div
      ref={menuRef}
      className="pointer-events-auto absolute z-[60] min-w-[10rem] overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-lg"
      style={{ left: 0, top: 0 }}
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
