import { type KanbanCardId, type KanbanCardSummary, type KanbanStatus } from "@bigbud/contracts";

import { ensureNativeApi } from "~/rpc/nativeApi";
import type { KanbanBoardChange } from "./kanban.logic";

interface RunKanbanCardContextMenuInput {
  readonly card: KanbanCardSummary;
  readonly cards: ReadonlyArray<KanbanCardSummary>;
  readonly position: { x: number; y: number };
  readonly onBoardChange: (change: KanbanBoardChange) => Promise<void>;
  readonly onCopyPath: (path: string) => void;
  readonly onDelete: (cardId: KanbanCardId) => Promise<void>;
  readonly onDuplicate: (card: KanbanCardSummary) => Promise<void>;
  readonly onEdit: (cardId: KanbanCardId) => Promise<void>;
}

export async function runKanbanCardContextMenu(
  input: RunKanbanCardContextMenuInput,
): Promise<void> {
  const action = await ensureNativeApi().contextMenu.show(
    [
      { id: "edit", label: "Edit task" },
      { id: "copy-path", label: "Copy path" },
      { id: "open-path", label: "Open externally" },
      { id: "duplicate", label: "Duplicate task" },
      { id: "move-backlog", label: "Move to Backlog", disabled: input.card.status === "backlog" },
      { id: "move-todo", label: "Move to Todo", disabled: input.card.status === "todo" },
      { id: "move-ongoing", label: "Move to Ongoing", disabled: input.card.status === "ongoing" },
      { id: "move-done", label: "Move to Done", disabled: input.card.status === "done" },
      { id: "delete", label: "Delete", destructive: true },
    ],
    input.position,
  );

  if (action === "edit") {
    await input.onEdit(input.card.cardId);
    return;
  }
  if (action === "copy-path") {
    input.onCopyPath(input.card.absolutePath);
    return;
  }
  if (action === "open-path") {
    await ensureNativeApi().shell.openPath(input.card.absolutePath);
    return;
  }
  if (action === "duplicate") {
    await input.onDuplicate(input.card);
    return;
  }
  if (action === "delete") {
    await input.onDelete(input.card.cardId);
    return;
  }
  if (action?.startsWith("move-")) {
    const nextStatus = action.replace("move-", "") as KanbanStatus;
    const targetIndex = input.cards.filter(
      (entry) => entry.status === nextStatus && entry.cardId !== input.card.cardId,
    ).length;
    await input.onBoardChange({
      cardId: input.card.cardId,
      status: nextStatus,
      targetIndex,
    });
  }
}
