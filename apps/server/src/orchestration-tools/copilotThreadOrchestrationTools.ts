import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import {
  BrowserAction,
  type BrowserAction as BrowserActionType,
  ComputerUseAction,
  type ComputerUseAction as ComputerUseActionType,
} from "@bigbud/contracts";
import { Schema } from "effect";

import {
  BROWSER_TOOL_DESCRIPTION,
  ARCHIVE_THREAD_TOOL_DESCRIPTION,
  CREATE_THREAD_TOOL_DESCRIPTION,
  GET_THREAD_STATUS_TOOL_DESCRIPTION,
  LIST_PINNED_THREADS_TOOL_DESCRIPTION,
  LIST_THREADS_TOOL_DESCRIPTION,
  PIN_THREAD_TOOL_DESCRIPTION,
  RENAME_THREAD_TOOL_DESCRIPTION,
  SEND_THREAD_MESSAGE_TOOL_DESCRIPTION,
  UNPIN_THREAD_TOOL_DESCRIPTION,
} from "./threadOrchestrationBridge.shared.ts";
import {
  COMPUTER_USE_TOOL_DESCRIPTION,
  COPILOT_COMPUTER_USE_PARAMETERS,
} from "./orchestrationComputerUseTool.shared.ts";
import { BROWSER_TOOL_PARAMETERS } from "./orchestrationBrowserTool.shared.ts";
import {
  LIST_THREADS_MAX_LIMIT,
  normalizeListThreadsStatus,
  type ListThreadsStatusFilter,
} from "./ThreadOrchestrationTools.listThreads.ts";
import {
  BIGBUD_PLAN_TRACKING_TOOL_DESCRIPTION,
  BIGBUD_PLAN_TRACKING_TOOL_NAME,
  BIGBUD_PLAN_TRACKING_TOOL_PARAMETERS,
  BIGBUD_PLAN_TRACKING_TOOL_SUCCESS_MESSAGE,
} from "./threadPlanTrackingTool.shared.ts";

function successResult(message: string): ToolResultObject {
  return {
    textResultForLlm: message,
    resultType: "success",
    sessionLog: message,
  };
}

function failureResult(message: string): ToolResultObject {
  return {
    textResultForLlm: message,
    resultType: "failure",
    error: message,
    sessionLog: message,
  };
}

export function createCopilotThreadOrchestrationTools(input: {
  readonly renameThread: (title: string) => Promise<{ readonly title: string }>;
  readonly archiveThread: () => Promise<void>;
  readonly getThreadStatus: (threadId: string) => Promise<Record<string, unknown>>;
  readonly listPinnedThreads: () => Promise<Record<string, unknown>>;
  readonly listThreads?: (input: {
    readonly projectId?: string;
    readonly status: ListThreadsStatusFilter;
    readonly limit?: number;
    readonly includeExcerpt: boolean;
  }) => Promise<Record<string, unknown>>;
  readonly setThreadPinned: (threadId: string, pinned: boolean) => Promise<Record<string, unknown>>;
  readonly computerUse: (action: ComputerUseActionType) => Promise<Record<string, unknown>>;
  readonly browser: (action: BrowserActionType) => Promise<Record<string, unknown>>;
  readonly createThread: (input: {
    readonly invocationId: string;
    readonly sourceMessageId: string;
    readonly title: string;
    readonly task: string;
    readonly projectId?: string;
    readonly watchForCompletion: boolean;
  }) => Promise<Record<string, unknown>>;
  readonly sendThreadMessage?: (input: {
    threadId: string;
    message: string;
    delivery: "auto" | "queue";
    invocationId: string;
  }) => Promise<Record<string, unknown>>;
}): ReadonlyArray<Tool<{ title?: string; threadId?: string } & Record<string, unknown>>> {
  const decodeComputerUseAction = Schema.decodeUnknownSync(ComputerUseAction);
  const decodeBrowserAction = Schema.decodeUnknownSync(BrowserAction);
  return [
    {
      name: "rename_thread",
      description: RENAME_THREAD_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "New thread title" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      handler: async ({ title }) => {
        try {
          const result = await input.renameThread(title ?? "");
          return successResult(`Renamed thread to "${result.title}".`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to rename thread.";
          return failureResult(message);
        }
      },
    },
    {
      name: "archive_thread",
      description: ARCHIVE_THREAD_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      handler: async () => {
        try {
          await input.archiveThread();
          return successResult("Archived the current thread.");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to archive thread.";
          return failureResult(message);
        }
      },
    },
    {
      name: "create_thread",
      description: CREATE_THREAD_TOOL_DESCRIPTION,
      parameters: {
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
      handler: async ({ title, task, projectId, watchForCompletion }, invocation) => {
        try {
          const trimmedTitle = typeof title === "string" ? title.trim() : "";
          const trimmedTask = typeof task === "string" ? task.trim() : "";
          if (trimmedTitle.length === 0) {
            throw new Error("Thread title cannot be empty.");
          }
          if (trimmedTask.length === 0) {
            throw new Error("Thread task cannot be empty.");
          }
          const trimmedProjectId = typeof projectId === "string" ? projectId.trim() : "";
          const result = await input.createThread({
            invocationId: invocation.toolCallId,
            sourceMessageId: invocation.toolCallId,
            title: trimmedTitle,
            task: trimmedTask,
            ...(trimmedProjectId ? { projectId: trimmedProjectId } : {}),
            watchForCompletion: watchForCompletion === true,
          });
          return successResult(JSON.stringify(result, null, 2));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to create thread.";
          return failureResult(message);
        }
      },
    },
    {
      name: "list_threads",
      description: LIST_THREADS_TOOL_DESCRIPTION,
      parameters: {
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
      handler: async (args) => {
        const listThreads = input.listThreads;
        if (!listThreads) {
          return failureResult("Thread listing is not ready.");
        }
        try {
          const projectId = typeof args.projectId === "string" ? args.projectId.trim() : "";
          const result = await listThreads({
            ...(projectId ? { projectId } : {}),
            status: normalizeListThreadsStatus(args.status),
            ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
            includeExcerpt: args.includeExcerpt === true,
          });
          return successResult(JSON.stringify(result, null, 2));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to list threads.";
          return failureResult(message);
        }
      },
    },
    {
      name: "list_pinned_threads",
      description: LIST_PINNED_THREADS_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      handler: async () => {
        try {
          const result = await input.listPinnedThreads();
          return successResult(JSON.stringify(result, null, 2));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to list pinned threads.";
          return failureResult(message);
        }
      },
    },
    {
      name: "pin_thread",
      description: PIN_THREAD_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread ID to pin" },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      handler: async ({ threadId }) => {
        try {
          const result = await input.setThreadPinned(threadId ?? "", true);
          return successResult(JSON.stringify(result, null, 2));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to pin thread.";
          return failureResult(message);
        }
      },
    },
    {
      name: "unpin_thread",
      description: UNPIN_THREAD_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread ID to unpin" },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      handler: async ({ threadId }) => {
        try {
          const result = await input.setThreadPinned(threadId ?? "", false);
          return successResult(JSON.stringify(result, null, 2));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to unpin thread.";
          return failureResult(message);
        }
      },
    },
    {
      name: BIGBUD_PLAN_TRACKING_TOOL_NAME,
      description: BIGBUD_PLAN_TRACKING_TOOL_DESCRIPTION,
      parameters: BIGBUD_PLAN_TRACKING_TOOL_PARAMETERS,
      handler: async () => successResult(BIGBUD_PLAN_TRACKING_TOOL_SUCCESS_MESSAGE),
    },
    {
      name: "browser",
      description: BROWSER_TOOL_DESCRIPTION,
      parameters: BROWSER_TOOL_PARAMETERS,
      handler: async (args) => {
        try {
          const action = decodeBrowserAction(args);
          const result = await input.browser(action);
          return successResult(JSON.stringify(result, null, 2));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Browser action failed.";
          return failureResult(message);
        }
      },
    },
    {
      name: "computer_use",
      description: COMPUTER_USE_TOOL_DESCRIPTION,
      parameters: COPILOT_COMPUTER_USE_PARAMETERS,
      handler: async (args) => {
        try {
          const action = decodeComputerUseAction(args);
          const result = await input.computerUse(action);
          return successResult(JSON.stringify(result, null, 2));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Computer-use action failed.";
          return failureResult(message);
        }
      },
    },
    {
      name: "send_thread_message",
      description: SEND_THREAD_MESSAGE_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          message: { type: "string" },
          delivery: { type: "string", enum: ["auto", "queue"] },
        },
        required: ["threadId", "message"],
        additionalProperties: false,
      },
      handler: async ({ threadId, message, delivery }, invocation) => {
        try {
          if (!input.sendThreadMessage) throw new Error("Thread messaging is not ready.");
          return successResult(
            JSON.stringify(
              await input.sendThreadMessage({
                threadId: String(threadId ?? ""),
                message: String(message ?? ""),
                delivery: delivery === "queue" ? "queue" : "auto",
                invocationId: invocation.toolCallId,
              }),
              null,
              2,
            ),
          );
        } catch (error) {
          return failureResult(
            error instanceof Error ? error.message : "Failed to send thread message.",
          );
        }
      },
    },
    {
      name: "get_thread_status",
      description: GET_THREAD_STATUS_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread ID to inspect" },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      handler: async ({ threadId }) => {
        try {
          const status = await input.getThreadStatus(threadId ?? "");
          return successResult(JSON.stringify(status, null, 2));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to read thread status.";
          return failureResult(message);
        }
      },
    },
  ];
}
