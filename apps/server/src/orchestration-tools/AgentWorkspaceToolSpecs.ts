import type { AgentWorkspaceToolName } from "./AgentWorkspaceTools.ts";

type JsonSchema = Record<string, unknown>;
export type AgentWorkspaceToolSpec = {
  readonly name: AgentWorkspaceToolName;
  readonly description: string;
  readonly inputSchema: JsonSchema;
};

const id = (name: "noteId" | "cardId") => ({ type: "string", description: `Stable ${name}.` });
const expectedUpdatedAt = {
  type: "string",
  description: "updatedAt value last read; rejects stale writes when provided.",
};
const status = { type: "string", enum: ["backlog", "todo", "ongoing", "done"] };
const targetIndex = { type: "integer", minimum: 0 };
const itemScope = { type: "string", enum: ["global", "project"] };
const scopeFilter = { type: "string", enum: ["all", "global", "project"], default: "all" };
const schema = (properties: JsonSchema, required: ReadonlyArray<string>): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const AGENT_WORKSPACE_TOOL_SPECS: ReadonlyArray<AgentWorkspaceToolSpec> = [
  {
    name: "list_notes",
    description: "List global notes and notes in the current thread's project. This is read-only.",
    inputSchema: schema({ scope: scopeFilter }, []),
  },
  {
    name: "get_note",
    description: "Read a global note or a note in the current thread's project.",
    inputSchema: schema({ noteId: id("noteId") }, ["noteId"]),
  },
  {
    name: "create_note",
    description: "Create a global note or a note in the current thread's project.",
    inputSchema: schema(
      { scope: itemScope, title: { type: "string" }, content: { type: "string" } },
      ["scope", "title", "content"],
    ),
  },
  {
    name: "update_note",
    description: "Update a global note or a note in the current thread's project.",
    inputSchema: schema(
      {
        noteId: id("noteId"),
        title: { type: "string" },
        content: { type: "string" },
        expectedUpdatedAt,
      },
      ["noteId", "title", "content"],
    ),
  },
  {
    name: "list_kanban_cards",
    description:
      "List global kanban cards and cards in the current thread's project. This is read-only.",
    inputSchema: schema({ scope: scopeFilter }, []),
  },
  {
    name: "get_kanban_card",
    description: "Read a global kanban card or a card in the current thread's project.",
    inputSchema: schema({ cardId: id("cardId") }, ["cardId"]),
  },
  {
    name: "create_kanban_card",
    description: "Create a global kanban card or a card in the current thread's project.",
    inputSchema: schema(
      { scope: itemScope, title: { type: "string" }, content: { type: "string" }, status },
      ["scope", "title", "content"],
    ),
  },
  {
    name: "update_kanban_card",
    description: "Update a global kanban card or a card in the current thread's project.",
    inputSchema: schema(
      {
        cardId: id("cardId"),
        title: { type: "string" },
        content: { type: "string" },
        expectedUpdatedAt,
      },
      ["cardId", "title", "content"],
    ),
  },
  {
    name: "move_kanban_card",
    description:
      "Move an accessible global or current-project kanban card to a status and optional position.",
    inputSchema: schema({ cardId: id("cardId"), status, targetIndex, expectedUpdatedAt }, [
      "cardId",
      "status",
    ]),
  },
  {
    name: "reorder_kanban_card",
    description: "Reorder an accessible global or current-project kanban card within a status.",
    inputSchema: schema({ cardId: id("cardId"), status, targetIndex, expectedUpdatedAt }, [
      "cardId",
      "status",
      "targetIndex",
    ]),
  },
];
