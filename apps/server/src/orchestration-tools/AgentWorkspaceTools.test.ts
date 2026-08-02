import { ProjectId, ThreadId, type OrchestrationReadModel } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProjectionKanbanRepositoryShape } from "../persistence/Services/ProjectionKanban.ts";
import type { ProjectionNoteRepositoryShape } from "../persistence/Services/ProjectionNotes.ts";
import { AGENT_WORKSPACE_TOOL_NAMES, makeAgentWorkspaceTool } from "./AgentWorkspaceTools.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const projectId = ProjectId.makeUnsafe("project-1");
const otherProjectId = ProjectId.makeUnsafe("project-2");
const readModel = () =>
  ({ threads: [{ id: threadId, projectId }] }) as unknown as OrchestrationReadModel;

const note = (overrides: Record<string, unknown> = {}) => ({
  noteId: "note-1" as never,
  projectId,
  title: "Note",
  content: "body",
  absolutePath: "/private/note.md",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});
const card = (overrides: Record<string, unknown> = {}) => ({
  cardId: "card-1" as never,
  projectId,
  title: "Card",
  content: "body",
  status: "todo" as const,
  absolutePath: "/private/card.md",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

function dependencies(
  input: {
    noteValue?: ReturnType<typeof note>;
    cardValue?: ReturnType<typeof card>;
    noteValues?: ReadonlyArray<ReturnType<typeof note>>;
    cardValues?: ReadonlyArray<ReturnType<typeof card>>;
  } = {},
) {
  const noteValue = input.noteValue ?? note();
  const cardValue = input.cardValue ?? card();
  const noteValues = input.noteValues ?? [noteValue];
  const cardValues = input.cardValues ?? [cardValue];
  const notes = {
    list: ({ projectId: selectedProjectId, scope: selectedScope }) =>
      Effect.succeed(
        noteValues.filter((value) =>
          selectedScope === "global"
            ? value.projectId === null
            : value.projectId === selectedProjectId,
        ),
      ),
    getById: () => Effect.succeed(Option.some(noteValue)),
    create: (value) => Effect.succeed({ ...noteValue, ...value }),
    update: (value) => Effect.succeed({ ...noteValue, ...value }),
    deleteById: vi.fn(() => Effect.void),
  } satisfies ProjectionNoteRepositoryShape;
  const kanban = {
    list: ({ projectId: selectedProjectId, scope: selectedScope }) =>
      Effect.succeed(
        cardValues.filter((value) =>
          selectedScope === "global"
            ? value.projectId === null
            : value.projectId === selectedProjectId,
        ),
      ),
    getById: () => Effect.succeed(Option.some(cardValue)),
    create: (value) => Effect.succeed({ ...cardValue, ...value }),
    update: (value) => Effect.succeed({ ...cardValue, ...value }),
    move: (value) => Effect.succeed({ ...cardValue, ...value }),
    reorderWithinStatus: (value) => Effect.succeed({ ...cardValue, ...value }),
    deleteById: vi.fn(() => Effect.void),
  } satisfies ProjectionKanbanRepositoryShape;
  return { readModel, notes, kanban };
}

const execute = (
  deps: ReturnType<typeof dependencies>,
  tool: Parameters<ReturnType<typeof makeAgentWorkspaceTool>>[0]["tool"],
  args = {},
) =>
  Effect.runPromise(
    makeAgentWorkspaceTool(deps)({ callerThreadId: threadId, tool, arguments: args }),
  );

describe("AgentWorkspaceTools", () => {
  it("lists global and current-project items by default with explicit scope", async () => {
    const deps = dependencies({
      noteValues: [
        note({ noteId: "global-note", projectId: null }),
        note({ noteId: "project-note" }),
        note({ noteId: "other-note", projectId: otherProjectId }),
      ],
      cardValues: [
        card({ cardId: "global-card", projectId: null }),
        card({ cardId: "project-card" }),
        card({ cardId: "other-card", projectId: otherProjectId }),
      ],
    });
    const result = await execute(deps, "list_notes");
    const cards = await execute(deps, "list_kanban_cards");
    expect(result).toMatchObject({
      notes: [
        { noteId: "global-note", projectId: null, scope: "global" },
        { noteId: "project-note", projectId, scope: "project" },
      ],
    });
    expect(cards).toMatchObject({
      cards: [
        { cardId: "global-card", projectId: null, scope: "global" },
        { cardId: "project-card", projectId, scope: "project" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("absolutePath");
    expect(JSON.stringify(cards)).not.toContain("absolutePath");
    expect(JSON.stringify({ result, cards })).not.toContain("other-");
  });

  it.each(["global", "project", "all"] as const)(
    "filters note and card lists to %s scope",
    async (scope) => {
      const deps = dependencies({
        noteValues: [note({ projectId: null }), note({ noteId: "note-2" })],
        cardValues: [card({ projectId: null }), card({ cardId: "card-2" })],
      });
      const notes = (
        (await execute(deps, "list_notes", { scope })) as {
          notes: ReadonlyArray<{ scope: string }>;
        }
      ).notes;
      const cards = (
        (await execute(deps, "list_kanban_cards", { scope })) as {
          cards: ReadonlyArray<{ scope: string }>;
        }
      ).cards;
      expect(notes.map((value) => value.scope)).toEqual(
        scope === "all" ? ["global", "project"] : [scope],
      );
      expect(cards.map((value) => value.scope)).toEqual(
        scope === "all" ? ["global", "project"] : [scope],
      );
    },
  );

  it("rejects invalid list scopes", async () => {
    await expect(execute(dependencies(), "list_notes", { scope: "other" })).rejects.toThrow(
      "Invalid scope filter",
    );
  });

  it("rejects an item belonging to another project as not found", async () => {
    const deps = dependencies({ noteValue: note({ projectId: otherProjectId }) });
    const getById = vi.spyOn(deps.notes, "getById");
    await expect(
      execute(deps, "get_note", {
        noteId: "note-1",
      }),
    ).rejects.toThrow("Note not found");
    expect(getById).not.toHaveBeenCalled();
  });

  it.each(["global", "project"] as const)("creates and reads %s items", async (scope) => {
    const scopedProjectId = scope === "global" ? null : projectId;
    const deps = dependencies({
      noteValue: note({ projectId: scopedProjectId }),
      cardValue: card({ projectId: scopedProjectId }),
    });
    const createNote = vi.spyOn(deps.notes, "create");
    const createCard = vi.spyOn(deps.kanban, "create");
    const createdNote = await execute(deps, "create_note", { scope, title: "N", content: "n" });
    const createdCard = await execute(deps, "create_kanban_card", {
      scope,
      title: "C",
      content: "c",
    });
    expect(createdNote).toMatchObject({ projectId: scopedProjectId, scope });
    expect(createdCard).toMatchObject({ projectId: scopedProjectId, scope });
    expect(createNote).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: scopedProjectId }),
    );
    expect(createCard).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: scopedProjectId }),
    );
    await expect(execute(deps, "get_note", { noteId: "note-1" })).resolves.toMatchObject({ scope });
    await expect(execute(deps, "get_kanban_card", { cardId: "card-1" })).resolves.toMatchObject({
      scope,
    });
  });

  it.each(["global", "project"] as const)(
    "rejects stale %s updates before writing",
    async (scope) => {
      const deps = dependencies({
        noteValue: note({ projectId: scope === "global" ? null : projectId }),
      });
      const update = vi.spyOn(deps.notes, "update");
      await expect(
        execute(deps, "update_note", {
          noteId: "note-1",
          title: "Changed",
          content: "new",
          expectedUpdatedAt: "stale",
        }),
      ).rejects.toThrow("changed since it was read");
      expect(update).not.toHaveBeenCalled();
    },
  );

  it.each(["global", "project"] as const)(
    "updates, moves, and reorders %s items without changing scope",
    async (scope) => {
      const scopedProjectId = scope === "global" ? null : projectId;
      const deps = dependencies({
        noteValue: note({ projectId: scopedProjectId }),
        cardValue: card({ projectId: scopedProjectId }),
      });
      const updateNote = vi.spyOn(deps.notes, "update");
      const updateCard = vi.spyOn(deps.kanban, "update");
      const move = vi.spyOn(deps.kanban, "move");
      const reorder = vi.spyOn(deps.kanban, "reorderWithinStatus");
      await execute(deps, "update_note", { noteId: "note-1", title: "N", content: "n" });
      await execute(deps, "update_kanban_card", {
        cardId: "card-1",
        title: "C",
        content: "c",
      });
      await execute(deps, "move_kanban_card", { cardId: "card-1", status: "ongoing" });
      await execute(deps, "reorder_kanban_card", {
        cardId: "card-1",
        status: "todo",
        targetIndex: 0,
      });
      for (const mutation of [updateNote, updateCard, move, reorder]) {
        expect(mutation).toHaveBeenCalledOnce();
        expect(mutation.mock.calls[0]![0]).not.toHaveProperty("projectId");
      }
    },
  );

  it("requires explicit valid scope for creation", async () => {
    await expect(
      execute(dependencies(), "create_note", { title: "N", content: "n" }),
    ).rejects.toThrow("scope is required");
    await expect(
      execute(dependencies(), "create_kanban_card", {
        scope: "other",
        title: "C",
        content: "c",
      }),
    ).rejects.toThrow("Invalid scope");
  });

  it("rejects stale card writes before repository mutation", async () => {
    const deps = dependencies({ cardValue: card({ projectId: null }) });
    const update = vi.spyOn(deps.notes, "update");
    const move = vi.spyOn(deps.kanban, "move");
    await expect(
      execute(deps, "move_kanban_card", {
        cardId: "card-1",
        status: "done",
        expectedUpdatedAt: "stale",
      }),
    ).rejects.toThrow("changed since it was read");
    expect(update).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it.each([
    "../notes/other.md",
    "notes/project-1/../../secret.md",
    "notes\\project-1\\secret.md",
    "/tmp/secret.md",
    "notes/project-2/secret.md",
  ])("rejects unsafe note IDs before getById: %s", async (noteId) => {
    const deps = dependencies();
    const getById = vi.spyOn(deps.notes, "getById");
    await expect(execute(deps, "get_note", { noteId })).rejects.toThrow("Note not found");
    expect(getById).not.toHaveBeenCalled();
  });

  it.each(["../kanban/other.md", "kanban/project-1/../../secret.md", "C:\\secret.md"])(
    "rejects unsafe card IDs before getById: %s",
    async (cardId) => {
      const deps = dependencies();
      const getById = vi.spyOn(deps.kanban, "getById");
      await expect(execute(deps, "get_kanban_card", { cardId })).rejects.toThrow(
        "Kanban card not found",
      );
      expect(getById).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid status and placement", async () => {
    await expect(
      execute(dependencies(), "move_kanban_card", { cardId: "card-1", status: "blocked" }),
    ).rejects.toThrow("Invalid kanban status");
    await expect(
      execute(dependencies(), "reorder_kanban_card", {
        cardId: "card-1",
        status: "todo",
        targetIndex: -1,
      }),
    ).rejects.toThrow("non-negative integer");
  });

  it("preserves note and card content exactly", async () => {
    const deps = dependencies();
    const createNote = vi.spyOn(deps.notes, "create");
    const createCard = vi.spyOn(deps.kanban, "create");
    const noteContent = "  indented note  \n```ts\n  code();\n```\n";
    const cardContent = "\n  indented card\t\n";
    await execute(deps, "create_note", { scope: "project", title: "Note", content: noteContent });
    await execute(deps, "create_kanban_card", {
      scope: "global",
      title: "Card",
      content: cardContent,
    });
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ content: noteContent }));
    expect(createCard).toHaveBeenCalledWith(expect.objectContaining({ content: cardContent }));
  });

  it("moves and reorders cards with validated placement", async () => {
    const deps = dependencies();
    const move = vi.spyOn(deps.kanban, "move");
    const reorder = vi.spyOn(deps.kanban, "reorderWithinStatus");
    await execute(deps, "move_kanban_card", {
      cardId: "card-1",
      status: "ongoing",
      targetIndex: 0,
    });
    await execute(deps, "reorder_kanban_card", {
      cardId: "card-1",
      status: "todo",
      targetIndex: 2,
    });
    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ongoing", targetIndex: 0 }),
    );
    expect(reorder).toHaveBeenCalledWith(
      expect.objectContaining({ status: "todo", targetIndex: 2 }),
    );
  });

  it("structurally omits deletion and never calls delete repositories", () => {
    const deps = dependencies();
    expect(AGENT_WORKSPACE_TOOL_NAMES.some((name) => name.includes("delete"))).toBe(false);
    expect(deps.notes.deleteById).not.toHaveBeenCalled();
    expect(deps.kanban.deleteById).not.toHaveBeenCalled();
  });
});
