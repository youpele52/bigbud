import type { CodexDynamicToolSpec } from "../codex/codexAppServerManager.types.ts";
import {
  READ_CAPABILITY_GUIDE_PARAMETERS,
  READ_CAPABILITY_GUIDE_TOOL_DESCRIPTION,
  SEARCH_CAPABILITIES_PARAMETERS,
  SEARCH_CAPABILITIES_TOOL_DESCRIPTION,
} from "./capabilityCatalogTool.shared.ts";
import { BROWSER_TOOL_PARAMETERS } from "./orchestrationBrowserTool.shared.ts";
import { COPILOT_COMPUTER_USE_PARAMETERS } from "./orchestrationComputerUseTool.shared.ts";
import { LIST_THREADS_MAX_LIMIT } from "./ThreadOrchestrationTools.listThreads.ts";
import {
  ARCHIVE_THREAD_TOOL_DESCRIPTION,
  BROWSER_TOOL_DESCRIPTION,
  COMPUTER_USE_TOOL_DESCRIPTION,
  CREATE_THREAD_TOOL_DESCRIPTION,
  GET_THREAD_STATUS_TOOL_DESCRIPTION,
  LIST_PINNED_THREADS_TOOL_DESCRIPTION,
  LIST_THREADS_TOOL_DESCRIPTION,
  PIN_THREAD_TOOL_DESCRIPTION,
  RENAME_THREAD_TOOL_DESCRIPTION,
  SEND_THREAD_MESSAGE_TOOL_DESCRIPTION,
  UNPIN_THREAD_TOOL_DESCRIPTION,
} from "./threadOrchestrationBridge.shared.ts";

export const BIGBUD_ORCHESTRATION_NAMESPACE = "bigbud_orchestration";

export function createCodexThreadOrchestrationDynamicTools(): ReadonlyArray<CodexDynamicToolSpec> {
  return [
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "search_capabilities",
      description: SEARCH_CAPABILITIES_TOOL_DESCRIPTION,
      inputSchema: SEARCH_CAPABILITIES_PARAMETERS,
    },
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "read_capability_guide",
      description: READ_CAPABILITY_GUIDE_TOOL_DESCRIPTION,
      inputSchema: READ_CAPABILITY_GUIDE_PARAMETERS,
    },
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "browser",
      description: BROWSER_TOOL_DESCRIPTION,
      inputSchema: BROWSER_TOOL_PARAMETERS,
    },
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "rename_thread",
      description: RENAME_THREAD_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: { title: { type: "string", description: "New thread title" } },
        required: ["title"],
        additionalProperties: false,
      },
    },
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "archive_thread",
      description: ARCHIVE_THREAD_TOOL_DESCRIPTION,
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "create_thread",
      description: CREATE_THREAD_TOOL_DESCRIPTION,
      inputSchema: {
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
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "get_thread_status",
      description: GET_THREAD_STATUS_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: { threadId: { type: "string", description: "Thread ID to inspect" } },
        required: ["threadId"],
        additionalProperties: false,
      },
    },
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "send_thread_message",
      description: SEND_THREAD_MESSAGE_TOOL_DESCRIPTION,
      inputSchema: {
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
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "list_threads",
      description: LIST_THREADS_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Project ID; defaults to the current project",
          },
          status: {
            type: "string",
            enum: ["active", "archived", "all"],
            description: "Thread status filter; defaults to active",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: LIST_THREADS_MAX_LIMIT,
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
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "list_pinned_threads",
      description: LIST_PINNED_THREADS_TOOL_DESCRIPTION,
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "pin_thread",
      description: PIN_THREAD_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: { threadId: { type: "string", description: "Thread ID to pin" } },
        required: ["threadId"],
        additionalProperties: false,
      },
    },
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "unpin_thread",
      description: UNPIN_THREAD_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: { threadId: { type: "string", description: "Thread ID to unpin" } },
        required: ["threadId"],
        additionalProperties: false,
      },
    },
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "computer_use",
      description: COMPUTER_USE_TOOL_DESCRIPTION,
      inputSchema: COPILOT_COMPUTER_USE_PARAMETERS,
    },
  ];
}
