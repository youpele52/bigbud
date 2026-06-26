import { type KanbanCardId, type KanbanStatus } from "@bigbud/contracts";

export interface KanbanCardWithPosition {
  readonly cardId: KanbanCardId;
  readonly status: KanbanStatus;
  readonly position: number;
}

export interface KanbanCardPositionUpdate {
  readonly cardId: KanbanCardId;
  readonly status: KanbanStatus;
  readonly position: number;
}

export function clampKanbanTargetIndex(targetIndex: number, columnLength: number): number {
  if (!Number.isFinite(targetIndex)) {
    return columnLength;
  }

  return Math.max(0, Math.min(Math.trunc(targetIndex), columnLength));
}

export function planKanbanColumnPlacement(
  cards: ReadonlyArray<KanbanCardWithPosition>,
  cardId: KanbanCardId,
  targetStatus: KanbanStatus,
  targetIndex: number,
): ReadonlyArray<KanbanCardPositionUpdate> | null {
  const moving = cards.find((card) => card.cardId === cardId);
  if (!moving) {
    return null;
  }

  const remaining = cards.filter((card) => card.cardId !== cardId);
  const targetColumn = remaining
    .filter((card) => card.status === targetStatus)
    .toSorted((a, b) => a.position - b.position);
  const clampedIndex = clampKanbanTargetIndex(targetIndex, targetColumn.length);
  const nextTargetColumn = [...targetColumn];
  nextTargetColumn.splice(clampedIndex, 0, { ...moving, status: targetStatus });

  const updates: Array<KanbanCardPositionUpdate> = nextTargetColumn.map((card, index) => ({
    cardId: card.cardId,
    status: targetStatus,
    position: index + 1,
  }));

  if (moving.status !== targetStatus) {
    const sourceColumn = remaining
      .filter((card) => card.status === moving.status)
      .toSorted((a, b) => a.position - b.position);

    for (const [index, card] of sourceColumn.entries()) {
      updates.push({
        cardId: card.cardId,
        status: moving.status,
        position: index + 1,
      });
    }
  }

  return updates;
}

export function nextKanbanColumnPosition(
  cards: ReadonlyArray<KanbanCardWithPosition>,
  status: KanbanStatus,
): number {
  const maxPosition = cards
    .filter((card) => card.status === status)
    .reduce((max, card) => Math.max(max, card.position), 0);

  return maxPosition + 1;
}
