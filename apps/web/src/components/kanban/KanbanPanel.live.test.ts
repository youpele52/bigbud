import { KanbanCardId, type KanbanCardSummary } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { hasUnsavedKanbanEdits, mergeEditingCardIntoBoard } from "./KanbanPanel.live";

const cardId = KanbanCardId.makeUnsafe("kanban/global/task-1.md");

const sampleCard: KanbanCardSummary = {
  cardId,
  projectId: null,
  title: "Original",
  status: "todo",
  absolutePath: "/tmp/kanban/global/task-1.md",
  createdAt: "2026-06-23T00:00:00.000Z",
  updatedAt: "2026-06-23T00:00:00.000Z",
};

describe("KanbanPanel.live", () => {
  it("detects unsaved editor changes", () => {
    expect(
      hasUnsavedKanbanEdits(
        { title: "Changed", content: "body", status: "todo" },
        { title: "Original", content: "body", status: "todo" },
      ),
    ).toBe(true);
    expect(
      hasUnsavedKanbanEdits(
        { title: "Original", content: "body", status: "todo" },
        { title: "Original", content: "body", status: "todo" },
      ),
    ).toBe(false);
  });

  it("merges in-progress editor state onto the visible board card", () => {
    expect(mergeEditingCardIntoBoard([sampleCard], cardId, "Renamed task", "ongoing")).toEqual([
      {
        ...sampleCard,
        title: "Renamed task",
        status: "ongoing",
      },
    ]);
  });
});
