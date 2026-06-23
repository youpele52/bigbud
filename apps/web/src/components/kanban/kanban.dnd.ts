import { type KanbanCardId } from "@bigbud/contracts";

import {
  BIGBUD_FILES_PANEL_DRAG_MIME,
  serializeFilesPanelDragEntry,
} from "../files/filesPanel.dnd";

export const BIGBUD_KANBAN_CARD_DRAG_MIME = "application/x-bigbud-kanban-card";

export const KANBAN_CARD_SURFACE_CLASS =
  "flex min-w-0 w-full overflow-hidden rounded-2xl border border-border bg-card px-4 py-3 text-left text-sm font-medium text-foreground shadow-xs";

const KANBAN_CARD_DRAG_IMAGE_BORDER_RADIUS = "1rem";

interface KanbanCardDragPayload {
  readonly cardId: KanbanCardId;
  readonly title: string;
  readonly absolutePath: string;
}

export function createKanbanCardDragImage(source: HTMLElement, title: string): HTMLElement {
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.style.position = "fixed";
  ghost.style.top = "-10000px";
  ghost.style.left = "0";
  ghost.style.width = `${rect.width}px`;
  ghost.style.maxWidth = `${rect.width}px`;
  ghost.style.margin = "0";
  ghost.style.pointerEvents = "none";
  ghost.style.opacity = "1";
  ghost.style.borderRadius = KANBAN_CARD_DRAG_IMAGE_BORDER_RADIUS;
  ghost.style.overflow = "hidden";
  ghost.classList.add("rounded-2xl");

  const label = ghost.querySelector("span");
  if (label) {
    label.textContent = title;
  } else {
    ghost.textContent = title;
  }

  return ghost;
}

export function prepareKanbanCardDragStart(
  event: React.DragEvent<HTMLElement>,
  card: KanbanCardDragPayload,
): void {
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData(BIGBUD_KANBAN_CARD_DRAG_MIME, card.cardId);
  event.dataTransfer.setData(
    BIGBUD_FILES_PANEL_DRAG_MIME,
    serializeFilesPanelDragEntry({
      name: `${card.title}.md`,
      path: card.absolutePath,
      entryKind: "file",
    }),
  );
  event.dataTransfer.setData("text/plain", card.title);

  const ghost = createKanbanCardDragImage(event.currentTarget, card.title);
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, event.nativeEvent.offsetX, event.nativeEvent.offsetY);
  window.requestAnimationFrame(() => {
    ghost.remove();
  });
}
