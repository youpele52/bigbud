import { type OrchestrationReadModel, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ProjectionKanbanRepositoryShape } from "../persistence/Services/ProjectionKanban.ts";
import type { ProjectionNoteRepositoryShape } from "../persistence/Services/ProjectionNotes.ts";

export const AGENT_WORKSPACE_TOOL_NAMES = [
  "list_notes",
  "get_note",
  "create_note",
  "update_note",
  "list_kanban_cards",
  "get_kanban_card",
  "create_kanban_card",
  "update_kanban_card",
  "move_kanban_card",
  "reorder_kanban_card",
] as const;

export type AgentWorkspaceToolName = (typeof AGENT_WORKSPACE_TOOL_NAMES)[number];
export type AgentWorkspaceToolInput = {
  readonly callerThreadId: ThreadId;
  readonly tool: AgentWorkspaceToolName;
  readonly arguments: Record<string, unknown>;
};

type Dependencies = {
  readonly readModel: () => OrchestrationReadModel;
  readonly notes: ProjectionNoteRepositoryShape;
  readonly kanban: ProjectionKanbanRepositoryShape;
};

const scalar = (args: Record<string, unknown>, key: string, required = true): string => {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (required && value.length === 0) throw new Error(`${key} is required.`);
  return value;
};
const content = (args: Record<string, unknown>): string =>
  typeof args.content === "string" ? args.content : "";
const scope = (args: Record<string, unknown>): "global" | "project" => {
  const value = scalar(args, "scope");
  if (value !== "global" && value !== "project") throw new Error("Invalid scope.");
  return value;
};
const listScope = (args: Record<string, unknown>): "all" | "global" | "project" => {
  const value = scalar(args, "scope", false) || "all";
  if (value !== "all" && value !== "global" && value !== "project") {
    throw new Error("Invalid scope filter.");
  }
  return value;
};
const status = (args: Record<string, unknown>) => {
  const value = scalar(args, "status");
  if (!(["backlog", "todo", "ongoing", "done"] as const).includes(value as never)) {
    throw new Error("Invalid kanban status.");
  }
  return value as "backlog" | "todo" | "ongoing" | "done";
};
const targetIndex = (args: Record<string, unknown>, required: boolean): number | undefined => {
  const value = args.targetIndex;
  if (value === undefined && !required) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("targetIndex must be a non-negative integer.");
  }
  return value as number;
};
const now = () => new Date().toISOString();
const noteResult = ({
  absolutePath: _,
  ...note
}: { absolutePath: string; projectId: unknown } & Record<string, unknown>) => ({
  ...note,
  scope: note.projectId === null ? "global" : "project",
});
const cardResult = ({
  absolutePath: _,
  ...card
}: { absolutePath: string; projectId: unknown } & Record<string, unknown>) => ({
  ...card,
  scope: card.projectId === null ? "global" : "project",
});

export function makeAgentWorkspaceTool(dependencies: Dependencies) {
  return Effect.fn("AgentWorkspaceTools.execute")(function* (input: AgentWorkspaceToolInput) {
    const thread = dependencies.readModel().threads.find(({ id }) => id === input.callerThreadId);
    if (!thread?.projectId) return yield* Effect.fail(new Error("Current project not found."));
    const projectId = thread.projectId;
    const args = input.arguments;
    const listNotes = Effect.fn("AgentWorkspaceTools.listNotes")(function* (
      selected: "all" | "global" | "project",
    ) {
      const global =
        selected === "project"
          ? []
          : yield* dependencies.notes.list({ projectId: null, scope: "global" });
      const project =
        selected === "global"
          ? []
          : yield* dependencies.notes.list({ projectId, scope: "project" });
      return [
        ...global.filter((note) => note.projectId === null),
        ...project.filter((note) => note.projectId === projectId),
      ];
    });
    const listCards = Effect.fn("AgentWorkspaceTools.listCards")(function* (
      selected: "all" | "global" | "project",
    ) {
      const global =
        selected === "project"
          ? []
          : yield* dependencies.kanban.list({ projectId: null, scope: "global" });
      const project =
        selected === "global"
          ? []
          : yield* dependencies.kanban.list({ projectId, scope: "project" });
      return [
        ...global.filter((card) => card.projectId === null),
        ...project.filter((card) => card.projectId === projectId),
      ];
    });
    const getNote = Effect.fn("AgentWorkspaceTools.getNote")(function* () {
      const requestedId = scalar(args, "noteId");
      const scoped = yield* listNotes("all");
      const note = scoped.find(({ noteId }) => noteId === requestedId);
      if (!note) return yield* Effect.fail(new Error("Note not found."));
      return note;
    });
    const getCard = Effect.fn("AgentWorkspaceTools.getCard")(function* () {
      const requestedId = scalar(args, "cardId");
      const scoped = yield* listCards("all");
      const card = scoped.find(({ cardId }) => cardId === requestedId);
      if (!card) return yield* Effect.fail(new Error("Kanban card not found."));
      return card;
    });
    const expectedUpdatedAt = () => scalar(args, "expectedUpdatedAt", false) || undefined;

    switch (input.tool) {
      case "list_notes": {
        const notes = yield* listNotes(listScope(args));
        return { notes: notes.map(noteResult) };
      }
      case "get_note":
        return noteResult(yield* getNote());
      case "create_note": {
        const timestamp = now();
        const selectedScope = scope(args);
        return noteResult(
          yield* dependencies.notes.create({
            projectId: selectedScope === "global" ? null : projectId,
            title: scalar(args, "title"),
            content: content(args),
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
      }
      case "update_note": {
        const note = yield* getNote();
        const expected = expectedUpdatedAt();
        if (expected && expected !== note.updatedAt)
          return yield* Effect.fail(
            new Error("Item changed since it was read. Reload and try again."),
          );
        return noteResult(
          yield* dependencies.notes.update({
            noteId: note.noteId,
            title: scalar(args, "title"),
            content: content(args),
            updatedAt: now(),
            expectedUpdatedAt: expected,
          }),
        );
      }
      case "list_kanban_cards": {
        const cards = yield* listCards(listScope(args));
        return { cards: cards.map(cardResult) };
      }
      case "get_kanban_card":
        return cardResult(yield* getCard());
      case "create_kanban_card": {
        const timestamp = now();
        const selectedScope = scope(args);
        return cardResult(
          yield* dependencies.kanban.create({
            projectId: selectedScope === "global" ? null : projectId,
            title: scalar(args, "title"),
            content: content(args),
            status: args.status === undefined ? "backlog" : status(args),
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
      }
      case "update_kanban_card": {
        const card = yield* getCard();
        const expected = expectedUpdatedAt();
        if (expected && expected !== card.updatedAt)
          return yield* Effect.fail(
            new Error("Item changed since it was read. Reload and try again."),
          );
        return cardResult(
          yield* dependencies.kanban.update({
            cardId: card.cardId,
            title: scalar(args, "title"),
            content: content(args),
            updatedAt: now(),
            expectedUpdatedAt: expected,
          }),
        );
      }
      case "move_kanban_card": {
        const card = yield* getCard();
        const expected = expectedUpdatedAt();
        if (expected && expected !== card.updatedAt)
          return yield* Effect.fail(
            new Error("Item changed since it was read. Reload and try again."),
          );
        return cardResult(
          yield* dependencies.kanban.move({
            cardId: card.cardId,
            status: status(args),
            targetIndex: targetIndex(args, false),
            updatedAt: now(),
            expectedUpdatedAt: expected,
          }),
        );
      }
      case "reorder_kanban_card": {
        const card = yield* getCard();
        const expected = expectedUpdatedAt();
        if (expected && expected !== card.updatedAt)
          return yield* Effect.fail(
            new Error("Item changed since it was read. Reload and try again."),
          );
        return cardResult(
          yield* dependencies.kanban.reorderWithinStatus({
            cardId: card.cardId,
            status: status(args),
            targetIndex: targetIndex(args, true)!,
            updatedAt: now(),
            expectedUpdatedAt: expected,
          }),
        );
      }
    }
  });
}
