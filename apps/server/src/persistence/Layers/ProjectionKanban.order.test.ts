import { KanbanCardId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { clampKanbanTargetIndex, planKanbanColumnPlacement } from "./ProjectionKanban.order.ts";

describe("ProjectionKanban.order", () => {
  it("clamps target indexes to the column bounds", () => {
    expect(clampKanbanTargetIndex(4, 2)).toBe(2);
    expect(clampKanbanTargetIndex(-1, 2)).toBe(0);
  });

  it("plans within-column reorders and cross-column moves", () => {
    const cards = [
      {
        cardId: KanbanCardId.makeUnsafe("kanban/global/a.md"),
        status: "backlog" as const,
        position: 1,
      },
      {
        cardId: KanbanCardId.makeUnsafe("kanban/global/b.md"),
        status: "backlog" as const,
        position: 2,
      },
      {
        cardId: KanbanCardId.makeUnsafe("kanban/global/c.md"),
        status: "todo" as const,
        position: 1,
      },
    ];

    const reorder = planKanbanColumnPlacement(
      cards,
      KanbanCardId.makeUnsafe("kanban/global/a.md"),
      "backlog",
      1,
    );
    expect(reorder).toEqual([
      { cardId: KanbanCardId.makeUnsafe("kanban/global/b.md"), status: "backlog", position: 1 },
      { cardId: KanbanCardId.makeUnsafe("kanban/global/a.md"), status: "backlog", position: 2 },
    ]);

    const move = planKanbanColumnPlacement(
      cards,
      KanbanCardId.makeUnsafe("kanban/global/a.md"),
      "todo",
      0,
    );
    expect(move).toEqual([
      { cardId: KanbanCardId.makeUnsafe("kanban/global/a.md"), status: "todo", position: 1 },
      { cardId: KanbanCardId.makeUnsafe("kanban/global/c.md"), status: "todo", position: 2 },
      { cardId: KanbanCardId.makeUnsafe("kanban/global/b.md"), status: "backlog", position: 1 },
    ]);
  });
});
