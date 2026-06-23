import { type KanbanCardId, type KanbanCardSummary, type KanbanStatus } from "@bigbud/contracts";
import { ChevronDownIcon, ChevronRightIcon, FilePlusIcon, StickyNoteIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import {
  type KanbanBoardChange,
  cardsInKanbanStatus,
  resolveKanbanDropTargetIndex,
} from "./kanban.logic";
import {
  BIGBUD_KANBAN_CARD_DRAG_MIME,
  KANBAN_CARD_SURFACE_CLASS,
  prepareKanbanCardDragStart,
} from "./kanban.dnd";

export { BIGBUD_KANBAN_CARD_DRAG_MIME } from "./kanban.dnd";

const KANBAN_COLUMNS: ReadonlyArray<{ status: KanbanStatus; label: string }> = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "Todo" },
  { status: "ongoing", label: "Ongoing" },
  { status: "done", label: "Done" },
];

const KANBAN_EXPANDED_COLUMN_CLASS =
  "flex min-h-0 w-[18rem] min-w-[18rem] max-w-[18rem] shrink-0 grow-0 flex-col overflow-hidden rounded-xl border border-border bg-card/60";

interface KanbanBoardProps {
  cards: ReadonlyArray<KanbanCardSummary>;
  editingCardId: KanbanCardId | null;
  onCardContextMenu: (card: KanbanCardSummary, position: { x: number; y: number }) => Promise<void>;
  onBoardChange: (change: KanbanBoardChange) => Promise<void>;
  onCreateCard: (status: KanbanStatus) => void;
  onSelectCard: (cardId: KanbanCardId) => void;
}

interface DropTarget {
  readonly status: KanbanStatus;
  readonly beforeCardId: KanbanCardId | null;
}

export function KanbanBoard({
  cards,
  editingCardId,
  onCardContextMenu,
  onBoardChange,
  onCreateCard,
  onSelectCard,
}: KanbanBoardProps) {
  const [collapsedColumns, setCollapsedColumns] = useState<ReadonlySet<KanbanStatus>>(
    () => new Set(),
  );
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<KanbanCardId | null>(null);

  const clearDragState = useCallback(() => {
    setDraggingCardId(null);
    setDropTarget(null);
  }, []);

  useEffect(() => {
    const handleDocumentDragEnd = () => {
      clearDragState();
    };

    document.addEventListener("dragend", handleDocumentDragEnd);
    return () => document.removeEventListener("dragend", handleDocumentDragEnd);
  }, [clearDragState]);

  const toggleColumnCollapsed = useCallback((status: KanbanStatus) => {
    setCollapsedColumns((current) => {
      const next = new Set(current);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }, []);

  const handleColumnDrop = useCallback(
    (
      event: React.DragEvent<HTMLElement>,
      status: KanbanStatus,
      beforeCardId: KanbanCardId | null,
    ) => {
      const cardId = event.dataTransfer.getData(BIGBUD_KANBAN_CARD_DRAG_MIME) as KanbanCardId | "";
      if (!cardId) return;
      event.preventDefault();
      event.stopPropagation();
      clearDragState();

      const columnCards = cardsInKanbanStatus(cards, status);
      const targetIndex = resolveKanbanDropTargetIndex(columnCards, beforeCardId);
      void onBoardChange({ cardId, status, targetIndex });
    },
    [cards, clearDragState, onBoardChange],
  );

  const handleColumnDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(BIGBUD_KANBAN_CARD_DRAG_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  }, []);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
      <div className="flex min-h-full w-max min-w-full gap-3 p-3">
        {KANBAN_COLUMNS.map((column) => {
          const columnCards = cards.filter((card) => card.status === column.status);
          const isCollapsed = collapsedColumns.has(column.status);

          if (isCollapsed) {
            return (
              <div
                key={column.status}
                className="flex w-11 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card/60"
                onDragOver={handleColumnDragOver}
                onDrop={(event) => handleColumnDrop(event, column.status, null)}
              >
                <div className="flex min-h-0 flex-1 flex-col items-center py-2">
                  <button
                    type="button"
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={`Expand ${column.label}`}
                    onClick={() => toggleColumnCollapsed(column.status)}
                  >
                    <ChevronRightIcon className="size-3.5" />
                  </button>
                  <div className="mt-3 flex min-h-0 flex-1 flex-col items-center gap-4">
                    <span className="rounded-full bg-foreground/8 px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-foreground [writing-mode:vertical-rl]">
                      {column.label}
                    </span>
                    <div className="flex flex-col items-center gap-1 text-muted-foreground [writing-mode:vertical-rl]">
                      <StickyNoteIcon className="size-3.5 shrink-0 rotate-90" />
                      <span className="text-xs tabular-nums">{columnCards.length}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div
              key={column.status}
              className={KANBAN_EXPANDED_COLUMN_CLASS}
              onDragOver={handleColumnDragOver}
            >
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={`Collapse ${column.label}`}
                    onClick={() => toggleColumnCollapsed(column.status)}
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </button>
                  <span className="rounded-full bg-foreground/8 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-foreground">
                    {column.label}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{columnCards.length}</span>
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={`Add task to ${column.label}`}
                    onClick={() => onCreateCard(column.status)}
                  >
                    <FilePlusIcon className="size-3.5" />
                  </button>
                </div>
              </div>
              <div
                className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2"
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(BIGBUD_KANBAN_CARD_DRAG_MIME)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTarget({ status: column.status, beforeCardId: null });
                }}
                onDrop={(event) => handleColumnDrop(event, column.status, null)}
              >
                {columnCards.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                    Drop here
                  </div>
                ) : null}
                {columnCards.map((card) => (
                  <button
                    key={card.cardId}
                    type="button"
                    draggable
                    onDragStart={(event) => {
                      setDraggingCardId(card.cardId);
                      prepareKanbanCardDragStart(event, card);
                    }}
                    onDragEnd={clearDragState}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes(BIGBUD_KANBAN_CARD_DRAG_MIME)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropTarget({ status: column.status, beforeCardId: card.cardId });
                    }}
                    onDrop={(event) => handleColumnDrop(event, column.status, card.cardId)}
                    onClick={() => onSelectCard(card.cardId)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      void onCardContextMenu(card, { x: event.clientX, y: event.clientY });
                    }}
                    className={cn(
                      KANBAN_CARD_SURFACE_CLASS,
                      "transition-colors hover:bg-accent/35",
                      editingCardId === card.cardId && "border-ring/45 bg-accent/40",
                      draggingCardId === card.cardId && "opacity-35",
                      dropTarget?.status === column.status &&
                        dropTarget.beforeCardId === card.cardId &&
                        "border-ring/45 bg-accent/25",
                    )}
                  >
                    <span className="line-clamp-2 min-w-0 break-words">{card.title}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
