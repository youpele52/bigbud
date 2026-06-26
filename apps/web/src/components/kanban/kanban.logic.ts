import { type KanbanCardId, type KanbanCardSummary, type KanbanStatus } from "@bigbud/contracts";

const KANBAN_STATUS_ORDER: ReadonlyArray<KanbanStatus> = ["backlog", "todo", "ongoing", "done"];

export interface KanbanBoardChange {
  readonly cardId: KanbanCardId;
  readonly status: KanbanStatus;
  readonly targetIndex: number;
}

export function cardsInKanbanStatus(
  cards: ReadonlyArray<KanbanCardSummary>,
  status: KanbanStatus,
): ReadonlyArray<KanbanCardSummary> {
  return cards.filter((card) => card.status === status);
}

export function resolveKanbanDropTargetIndex(
  columnCards: ReadonlyArray<KanbanCardSummary>,
  beforeCardId: KanbanCardId | null,
): number {
  if (beforeCardId === null) {
    return columnCards.length;
  }

  const index = columnCards.findIndex((card) => card.cardId === beforeCardId);
  return index === -1 ? columnCards.length : index;
}

export function applyKanbanBoardChange(
  cards: ReadonlyArray<KanbanCardSummary>,
  change: KanbanBoardChange,
): ReadonlyArray<KanbanCardSummary> {
  const moving = cards.find((card) => card.cardId === change.cardId);
  if (!moving) {
    return cards;
  }

  const remaining = cards.filter((card) => card.cardId !== change.cardId);
  const targetColumn = remaining.filter((card) => card.status === change.status);
  const clampedIndex = Math.max(0, Math.min(change.targetIndex, targetColumn.length));
  const nextTargetColumn = [...targetColumn];
  nextTargetColumn.splice(clampedIndex, 0, { ...moving, status: change.status });

  const nextCards: KanbanCardSummary[] = [];
  for (const status of KANBAN_STATUS_ORDER) {
    if (status === change.status) {
      nextCards.push(...nextTargetColumn);
      continue;
    }

    nextCards.push(...remaining.filter((card) => card.status === status));
  }

  return nextCards;
}

export function isKanbanReorderChange(
  cards: ReadonlyArray<KanbanCardSummary>,
  change: KanbanBoardChange,
): boolean {
  const moving = cards.find((card) => card.cardId === change.cardId);
  return moving?.status === change.status;
}
