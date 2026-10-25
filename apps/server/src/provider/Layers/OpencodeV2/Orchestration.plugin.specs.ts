/** Bootstrap ABI 1. Public schemas/ordering are frozen, not recomputed from mutable canonical specs. */
export const V2_NATIVE_BOOTSTRAP_SPECS = [
  {
    name: "bigbud_thread_v1_rename_thread",
    action: "rename_thread",
    description:
      "Rename canonical bigbud thread metadata, not a native provider session. Omit targetThreadId for the current thread. Rename another thread only when the current user explicitly requests it; only current-project threads and directly delegated children are eligible, with existing approvals. Attached history alone does not authorize renaming.",
    input: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "New canonical thread title",
        },
        targetThreadId: {
          type: "string",
          minLength: 1,
          description:
            "Optional canonical thread ID; omit for the current thread. Only explicitly requested current-project threads or directly delegated children are eligible.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "bigbud_thread_v1_create_thread",
    action: "create_thread",
    description:
      "Create a standalone bigbud thread in a project and optionally watch it for completion.",
    input: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title for the new standalone bigbud thread" },
        task: { type: "string", description: "Task for the new standalone bigbud thread" },
        projectId: { type: "string", description: "Optional target project ID" },
        watchForCompletion: {
          type: "boolean",
          description: "Whether to watch the child thread for completion",
        },
      },
      required: ["title", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "bigbud_thread_v1_get_thread_status",
    action: "get_thread_status",
    description:
      "Get live workflow status for a bigbud thread in the current project or a directly delegated child. Use this to check whether another thread's agent is still working before starting dependent work.",
    input: {
      type: "object",
      properties: { threadId: { type: "string", description: "Thread ID to inspect" } },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "bigbud_thread_v1_send_thread_message",
    action: "send_thread_message",
    description:
      "Send a follow-up message to an existing bigbud thread in the current project or a directly delegated child. Starts it when safely idle or queues it durably while busy.",
    input: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Target thread ID" },
        message: { type: "string", description: "Follow-up message" },
        delivery: {
          type: "string",
          enum: ["auto", "queue"],
          description: "Delivery policy; defaults to auto",
        },
      },
      required: ["threadId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "bigbud_thread_v1_list_threads",
    action: "list_threads",
    description:
      "List the bigbud threads in a project with their live workflow status. Defaults to the current project and to threads that are not archived. This is read-only. Results are ordered by most recently updated and are capped, so check hasMore before reporting a total.",
    input: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID; defaults to the current project" },
        status: {
          type: "string",
          enum: ["active", "archived", "all"],
          description: "Thread status filter; defaults to active",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum threads to return",
        },
        includeExcerpt: {
          type: "boolean",
          description: "Include a short excerpt of each thread's last assistant message",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
] as const;

export const V2_BOOTSTRAP_ABI = "bigbud.thread.bootstrap.v1";
