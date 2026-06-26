import {
  type KanbanCard,
  type KanbanCardId,
  type KanbanCardSummary,
  type KanbanStatus,
} from "@bigbud/contracts";

import { ensureNativeApi } from "~/rpc/nativeApi";
import { applyKanbanBoardChange, isKanbanReorderChange } from "./kanban.logic";

export async function persistKanbanBoardChange(input: {
  readonly previousCards: ReadonlyArray<KanbanCardSummary>;
  readonly change: {
    readonly cardId: KanbanCardId;
    readonly status: KanbanStatus;
    readonly targetIndex: number;
  };
  readonly editingCard: KanbanCard | null;
}): Promise<{
  readonly cards: ReadonlyArray<KanbanCardSummary>;
  readonly moved: KanbanCard;
}> {
  const moved = isKanbanReorderChange(input.previousCards, input.change)
    ? await ensureNativeApi().kanban.reorder({
        cardId: input.change.cardId,
        status: input.change.status,
        targetIndex: input.change.targetIndex,
      })
    : await ensureNativeApi().kanban.move({
        cardId: input.change.cardId,
        status: input.change.status,
        targetIndex: input.change.targetIndex,
      });

  const optimisticCards = applyKanbanBoardChange(input.previousCards, input.change);
  const cards = optimisticCards.map((card) => {
    if (card.cardId !== moved.cardId) {
      return card;
    }

    return {
      cardId: card.cardId,
      projectId: card.projectId,
      title: card.title,
      status: moved.status,
      absolutePath: card.absolutePath,
      createdAt: card.createdAt,
      updatedAt: moved.updatedAt,
    };
  });

  return { cards, moved };
}

export async function duplicateKanbanCard(card: KanbanCardSummary): Promise<void> {
  const fullCard = await ensureNativeApi().kanban.get({ cardId: card.cardId });
  await ensureNativeApi().kanban.create({
    projectId: fullCard.projectId,
    title: `Copy of ${fullCard.title}`,
    content: fullCard.content,
    status: fullCard.status,
  });
}
