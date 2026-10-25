/**
 * Copilot SDK bindings for the thread tools: delegation (`create_thread`, its read-only sibling
 * `list_available_models`), listing, pins, messaging and status. Split from
 * `copilotThreadOrchestrationTools.ts` by concern.
 */
import type { Tool } from "@github/copilot-sdk";

import {
  CREATE_THREAD_WITH_MODEL_CHOICE_TOOL_DESCRIPTION,
  CREATE_THREAD_TOOL_PARAMETERS,
  GET_THREAD_STATUS_TOOL_DESCRIPTION,
  LIST_AVAILABLE_MODELS_PARAMETERS,
  LIST_AVAILABLE_MODELS_TOOL_DESCRIPTION,
  LIST_PINNED_THREADS_TOOL_DESCRIPTION,
  LIST_THREADS_TOOL_DESCRIPTION,
  PIN_THREAD_TOOL_DESCRIPTION,
  SEND_THREAD_MESSAGE_TOOL_DESCRIPTION,
  UNPIN_THREAD_TOOL_DESCRIPTION,
} from "./threadOrchestrationBridge.shared.ts";
import {
  LIST_THREADS_MAX_LIMIT,
  normalizeListThreadsStatus,
  type ListThreadsStatusFilter,
} from "./ThreadOrchestrationTools.listThreads.ts";
import { failureResult, successResult } from "./copilotThreadOrchestrationTools.results.ts";

export interface CopilotThreadToolsInput {
  readonly getThreadStatus: (threadId: string) => Promise<Record<string, unknown>>;
  readonly listPinnedThreads: () => Promise<Record<string, unknown>>;
  readonly listThreads?: (input: {
    readonly projectId?: string;
    readonly status: ListThreadsStatusFilter;
    readonly limit?: number;
    readonly includeExcerpt: boolean;
  }) => Promise<Record<string, unknown>>;
  readonly setThreadPinned: (threadId: string, pinned: boolean) => Promise<Record<string, unknown>>;
  readonly createThread: (input: {
    readonly invocationId: string;
    readonly sourceMessageId: string;
    readonly title: string;
    readonly task: string;
    readonly projectId?: string;
    readonly watchForCompletion: boolean;
    /** Raw agent request; validated server-side and never a reason to fail. */
    readonly modelSelection?: unknown;
  }) => Promise<Record<string, unknown>>;
  readonly listAvailableModels?: (input: {
    readonly limit?: number;
  }) => Promise<Record<string, unknown>>;
  readonly sendThreadMessage?: (input: {
    threadId: string;
    message: string;
    delivery: "auto" | "queue";
    invocationId: string;
  }) => Promise<Record<string, unknown>>;
}

type CopilotThreadTool = Tool<{ title?: string; threadId?: string } & Record<string, unknown>>;

export function createCopilotThreadDelegationTools(
  input: CopilotThreadToolsInput,
): ReadonlyArray<CopilotThreadTool> {
  return [
    {
      name: "create_thread",
      description: CREATE_THREAD_WITH_MODEL_CHOICE_TOOL_DESCRIPTION,
      parameters: CREATE_THREAD_TOOL_PARAMETERS,
      handler: async (
        { title, task, projectId, watchForCompletion, modelSelection },
        invocation,
      ) => {
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
            // Raw: the server validates it and falls back rather than failing (Goal 11).
            ...(modelSelection !== undefined ? { modelSelection } : {}),
          });
          return successResult(JSON.stringify(result, null, 2));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to create thread.";
          return failureResult(message);
        }
      },
    },
    {
      name: "list_available_models",
      description: LIST_AVAILABLE_MODELS_TOOL_DESCRIPTION,
      parameters: LIST_AVAILABLE_MODELS_PARAMETERS,
      handler: async (args) => {
        const listAvailableModels = input.listAvailableModels;
        if (!listAvailableModels) return failureResult("Model listing is not ready.");
        try {
          const result = await listAvailableModels(
            typeof args.limit === "number" ? { limit: args.limit } : {},
          );
          return successResult(JSON.stringify(result, null, 2));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to list models.";
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
  ];
}

export function createCopilotThreadMessagingTools(
  input: CopilotThreadToolsInput,
): ReadonlyArray<CopilotThreadTool> {
  return [
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
