import type { Tool, ToolResultObject } from "@github/copilot-sdk";

import {
  ARCHIVE_THREAD_TOOL_DESCRIPTION,
  RENAME_THREAD_TOOL_DESCRIPTION,
} from "./threadOrchestrationBridge.shared.ts";

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
}): ReadonlyArray<Tool<{ title?: string }>> {
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
  ];
}
