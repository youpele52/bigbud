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
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
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
    itemRefs.current = [];
    const focusFrame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
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
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!anchor) return null;

  return (
    <div
      ref={menuRef}
      className="pointer-events-auto absolute z-[60] max-h-[calc(100%-0.5rem)] min-w-[12rem] overflow-y-auto rounded-sm border border-border bg-card p-1 text-foreground shadow-lg"
      style={{ left: 0, top: 0 }}
      tabIndex={-1}
      role="menu"
      onKeyDown={(event) => {
        const enabledItems = itemRefs.current.filter(
          (item): item is HTMLButtonElement => item !== null && !item.disabled,
        );
        if (enabledItems.length === 0) return;
        const currentIndex = enabledItems.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          const nextIndex = (currentIndex + direction + enabledItems.length) % enabledItems.length;
          enabledItems[nextIndex]?.focus();
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          const nextIndex = event.key === "Home" ? 0 : enabledItems.length - 1;
          enabledItems[nextIndex]?.focus();
        }
      }}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={item.id} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={item.id}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            role="menuitem"
            type="button"
            disabled={item.disabled}
            className={cn(
              "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs transition-colors focus-visible:bg-accent focus-visible:outline-none",
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
