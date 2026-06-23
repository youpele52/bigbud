import { KanbanCardId } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { KanbanBoard } from "./KanbanBoard";
import { KANBAN_CARD_SURFACE_CLASS } from "./kanban.dnd";

vi.mock("./kanban.dnd", async () => {
  const actual = await vi.importActual<typeof import("./kanban.dnd")>("./kanban.dnd");
  return {
    ...actual,
    prepareKanbanCardDragStart: vi.fn(),
  };
});

const sampleCard = {
  cardId: KanbanCardId.makeUnsafe("kanban/global/task-1.md"),
  projectId: null,
  title: "sleep earlier than 12am",
  status: "todo" as const,
  absolutePath: "/tmp/kanban/global/task-1.md",
  createdAt: "2026-06-23T00:00:00.000Z",
  updatedAt: "2026-06-23T00:00:00.000Z",
};

describe("KanbanBoard", () => {
  it("renders kanban cards with pill-shaped surfaces", () => {
    const markup = renderToStaticMarkup(
      <KanbanBoard
        cards={[sampleCard]}
        editingCardId={null}
        onBoardChange={async () => {}}
        onCardContextMenu={async () => {}}
        onCreateCard={() => {}}
        onSelectCard={() => {}}
      />,
    );

    expect(markup).toContain('draggable="true"');
    expect(markup).toContain(KANBAN_CARD_SURFACE_CLASS);
    expect(markup).toContain("rounded-2xl");
    expect(markup).toContain("sleep earlier than 12am");
  });
});
