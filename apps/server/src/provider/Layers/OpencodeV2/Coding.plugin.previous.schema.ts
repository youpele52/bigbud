/** Byte-exact native-access-era schema. Never derive historical upgrade identity from live contracts. */
export const V2_PREVIOUS_CODING_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "rename",
        "archive",
        "get_status",
        "list_pinned",
        "pin",
        "unpin",
        "browser",
        "computer_use",
        "create_thread",
        "send_thread_message",
        "list_threads",
        "search_capabilities",
        "read_capability_guide",
        "workspace",
        "get_system_resources",
      ],
    },
    threadId: { anyOf: [{ type: "string" }, { type: "null" }] },
    title: { anyOf: [{ type: "string" }, { type: "null" }] },
    computerUseAction: { anyOf: [{}, { type: "null" }] },
    browserAction: { anyOf: [{}, { type: "null" }] },
    task: { anyOf: [{ type: "string" }, { type: "null" }] },
    message: { anyOf: [{ type: "string" }, { type: "null" }] },
    delivery: { anyOf: [{ type: "string", enum: ["auto", "queue"] }, { type: "null" }] },
    projectId: { anyOf: [{ type: "string" }, { type: "null" }] },
    status: { anyOf: [{ type: "string", enum: ["active", "archived", "all"] }, { type: "null" }] },
    limit: {
      anyOf: [
        {
          anyOf: [
            { type: "number" },
            { type: "string", enum: ["NaN"] },
            { type: "string", enum: ["Infinity"] },
            { type: "string", enum: ["-Infinity"] },
          ],
        },
        { type: "null" },
      ],
    },
    includeExcerpt: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    watchForCompletion: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    query: { anyOf: [{ type: "string" }, { type: "null" }] },
    capabilityId: { anyOf: [{ type: "string" }, { type: "null" }] },
    section: {
      anyOf: [
        { type: "string", enum: ["summary", "workflow", "permissions", "examples", "full"] },
        { type: "null" },
      ],
    },
    workspaceTool: {
      anyOf: [
        {
          type: "string",
          enum: [
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
          ],
        },
        { type: "null" },
      ],
    },
    workspaceArguments: { anyOf: [{ type: "object" }, { type: "null" }] },
  },
  required: ["action"],
  additionalProperties: false,
};
