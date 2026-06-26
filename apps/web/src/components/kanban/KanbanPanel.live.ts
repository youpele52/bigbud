import {
  type KanbanCard,
  type KanbanCardId,
  type KanbanCardSummary,
  type KanbanStatus,
  type ProjectId,
} from "@bigbud/contracts";

import { ensureNativeApi } from "~/rpc/nativeApi";

interface KanbanEditorSnapshot {
  readonly title: string;
  readonly content: string;
  readonly status: KanbanStatus;
}

interface RefreshKanbanCardsListInput {
  readonly projectId: ProjectId | null;
  readonly resolvedScope: "project" | "global";
  readonly editingCardId: KanbanCardId | null;
  readonly currentCards: ReadonlyArray<KanbanCardSummary>;
  readonly editor: KanbanEditorSnapshot;
  readonly saved: KanbanEditorSnapshot;
  readonly isSaving: boolean;
}

export function hasUnsavedKanbanEdits(
  editor: KanbanEditorSnapshot,
  saved: KanbanEditorSnapshot,
): boolean {
  return (
    editor.title !== saved.title ||
    editor.content !== saved.content ||
    editor.status !== saved.status
  );
}

export function mergeEditingCardIntoBoard(
  cards: ReadonlyArray<KanbanCardSummary>,
  editingCardId: KanbanCardId | null,
  editorTitle: string,
  editorStatus: KanbanStatus,
): ReadonlyArray<KanbanCardSummary> {
  if (!editingCardId) {
    return cards;
  }

  const trimmedTitle = editorTitle.trim();
  return cards.map((card) =>
    card.cardId === editingCardId
      ? {
          ...card,
          title: trimmedTitle.length > 0 ? trimmedTitle : card.title,
          status: editorStatus,
        }
      : card,
  );
}

export async function refreshKanbanCardsList(
  input: RefreshKanbanCardsListInput,
): Promise<
  | { type: "list"; cards: ReadonlyArray<KanbanCardSummary> }
  | { type: "sync"; cards: ReadonlyArray<KanbanCardSummary>; card: KanbanCard }
> {
  if (input.isSaving) {
    const result = await ensureNativeApi().kanban.list({
      projectId: input.projectId,
      scope: input.resolvedScope,
    });
    return { type: "list", cards: result.cards };
  }

  const result = await ensureNativeApi().kanban.list({
    projectId: input.projectId,
    scope: input.resolvedScope,
  });

  if (!input.editingCardId) {
    return { type: "list", cards: result.cards };
  }

  const currentEditingCard = input.currentCards.find((card) => card.cardId === input.editingCardId);
  const refreshedEditingCard = result.cards.find((card) => card.cardId === input.editingCardId);

  if (
    !currentEditingCard ||
    !refreshedEditingCard ||
    refreshedEditingCard.updatedAt === currentEditingCard.updatedAt ||
    hasUnsavedKanbanEdits(input.editor, input.saved)
  ) {
    return { type: "list", cards: result.cards };
  }

  const card = await ensureNativeApi().kanban.get({ cardId: input.editingCardId });
  return { type: "sync", cards: result.cards, card };
}
