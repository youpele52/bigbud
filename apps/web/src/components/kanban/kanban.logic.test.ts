import { KanbanCardId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  applyKanbanBoardChange,
  cardsInKanbanStatus,
  isKanbanReorderChange,
  resolveKanbanDropTargetIndex,
} from "./kanban.logic";

const cardA = {
  cardId: KanbanCardId.makeUnsafe("kanban/global/a.md"),
  projectId: null,
  title: "A",
  status: "backlog" as const,
  absolutePath: "/tmp/a.md",
  createdAt: "2026-06-23T00:00:00.000Z",
  updatedAt: "2026-06-23T00:00:00.000Z",
};

const cardB = {
  ...cardA,
  cardId: KanbanCardId.makeUnsafe("kanban/global/b.md"),
  title: "B",
  absolutePath: "/tmp/b.md",
};

const cardC = {
  ...cardA,
  cardId: KanbanCardId.makeUnsafe("kanban/global/c.md"),
  title: "C",
  status: "todo" as const,
  absolutePath: "/tmp/c.md",
};

describe("kanban.logic", () => {
  it("resolves drop target index before a card or at the end", () => {
    expect(resolveKanbanDropTargetIndex([cardA, cardB], cardB.cardId)).toBe(1);
    expect(resolveKanbanDropTargetIndex([cardA, cardB], null)).toBe(2);
  });

  it("reorders cards within the same column", () => {
    const next = applyKanbanBoardChange([cardA, cardB], {
      cardId: cardA.cardId,
      status: "backlog",
      targetIndex: 1,
    });

    expect(cardsInKanbanStatus(next, "backlog").map((card) => card.title)).toEqual(["B", "A"]);
  });

  it("moves cards across columns at the requested index", () => {
    const next = applyKanbanBoardChange([cardA, cardB, cardC], {
      cardId: cardA.cardId,
      status: "todo",
      targetIndex: 0,
    });

    expect(cardsInKanbanStatus(next, "todo").map((card) => card.title)).toEqual(["A", "C"]);
    expect(cardsInKanbanStatus(next, "backlog").map((card) => card.title)).toEqual(["B"]);
  });

  it("detects reorder-only board changes", () => {
    expect(
      isKanbanReorderChange([cardA, cardB], {
        cardId: cardA.cardId,
        status: "backlog",
        targetIndex: 1,
      }),
    ).toBe(true);
    expect(
      isKanbanReorderChange([cardA, cardB], {
        cardId: cardA.cardId,
        status: "todo",
        targetIndex: 0,
      }),
    ).toBe(false);
  });
});
