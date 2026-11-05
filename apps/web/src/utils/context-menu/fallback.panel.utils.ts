import type { ContextMenuItem } from "@bigbud/contracts";

const ITEM_BASE_CLASS = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px]";
const ITEM_CLASS = `${ITEM_BASE_CLASS} text-popover-foreground hover:bg-accent focus:bg-accent focus:outline-none cursor-default`;
const DESTRUCTIVE_ITEM_CLASS = `${ITEM_BASE_CLASS} text-destructive hover:bg-accent focus:bg-accent focus:outline-none cursor-default`;
const DISABLED_ITEM_CLASS = `${ITEM_BASE_CLASS} text-muted-foreground/60 cursor-not-allowed`;

interface PanelHandlers<T extends string> {
  readonly onSelect: (id: T) => void;
  readonly onOpenSubmenu: (
    parent: HTMLButtonElement,
    children: readonly ContextMenuItem<T>[],
    viaKeyboard: boolean,
  ) => void;
  readonly onHoverPlainItem?: () => void;
}

/** Builds one menu panel. Separators never lead, trail, or repeat. */
export function createContextMenuPanel<T extends string>(
  items: readonly ContextMenuItem<T>[],
  handlers: PanelHandlers<T>,
): HTMLElement {
  const panel = document.createElement("div");
  panel.setAttribute("role", "menu");
  panel.className =
    "fixed z-[10000] min-w-[140px] rounded-md border border-border bg-popover py-1 shadow-xl animate-in fade-in zoom-in-95";
  const hasChoices = items.some((item) => item.checked !== undefined);

  for (const item of items) {
    if (item.separator) {
      const last = panel.lastElementChild;
      if (last === null || last.getAttribute("role") === "separator") continue;
      const separator = document.createElement("div");
      separator.className = "my-1 border-t border-border";
      separator.setAttribute("role", "separator");
      panel.appendChild(separator);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    const isDisabled = item.disabled === true;
    const children = item.children ?? [];
    button.disabled = isDisabled;
    button.className = isDisabled
      ? DISABLED_ITEM_CLASS
      : item.destructive === true || item.id === "delete"
        ? DESTRUCTIVE_ITEM_CLASS
        : ITEM_CLASS;
    if (hasChoices) {
      button.setAttribute("role", "menuitemcheckbox");
      button.setAttribute("aria-checked", item.checked === true ? "true" : "false");
      const mark = document.createElement("span");
      mark.className = "inline-block w-3 shrink-0";
      mark.textContent = item.checked === true ? "✓" : "";
      button.appendChild(mark);
    } else {
      button.setAttribute("role", "menuitem");
    }
    const label = document.createElement("span");
    label.className = "flex-1";
    label.textContent = item.label;
    button.appendChild(label);

    if (children.length > 0) {
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      const chevron = document.createElement("span");
      chevron.className = "text-muted-foreground";
      chevron.textContent = "›";
      button.appendChild(chevron);
      if (!isDisabled) {
        button.addEventListener("mouseenter", () =>
          handlers.onOpenSubmenu(button, children, false),
        );
        button.addEventListener("click", () => handlers.onOpenSubmenu(button, children, false));
        button.addEventListener("keydown", (event) => {
          if (event.key !== "ArrowRight" && event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          handlers.onOpenSubmenu(button, children, true);
        });
      }
    } else if (!isDisabled) {
      button.addEventListener("mouseenter", () => handlers.onHoverPlainItem?.());
      button.addEventListener("click", () => handlers.onSelect(item.id));
    }
    panel.appendChild(button);
  }
  while (panel.lastElementChild?.getAttribute("role") === "separator") {
    panel.lastElementChild.remove();
  }
  return panel;
}

/**
 * Positions a panel and keeps it inside the viewport. When a submenu would overflow on the right,
 * it opens to the left of `flipX` instead.
 */
export function positionContextMenuPanel(
  panel: HTMLElement,
  position: { readonly x: number; readonly y: number },
  flipX?: number,
): void {
  panel.style.top = `${position.y}px`;
  panel.style.left = `${position.x}px`;
  requestAnimationFrame(() => {
    const rect = panel.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      const left = flipX !== undefined ? flipX - rect.width : window.innerWidth - rect.width - 4;
      panel.style.left = `${Math.max(4, left)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      panel.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
    }
  });
}

function enabledButtons(panel: HTMLElement): HTMLButtonElement[] {
  return Array.from(panel.querySelectorAll("button")).filter((button) => !button.disabled);
}

export function focusFirstMenuButton(panel: HTMLElement): void {
  enabledButtons(panel)[0]?.focus();
}

/** Moves focus to the next or previous enabled item, wrapping around. */
export function moveMenuFocus(panel: HTMLElement, step: 1 | -1): void {
  const buttons = enabledButtons(panel);
  if (buttons.length === 0) return;
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = index === -1 ? (step === 1 ? 0 : buttons.length - 1) : index + step;
  buttons[(next + buttons.length) % buttons.length]?.focus();
}
