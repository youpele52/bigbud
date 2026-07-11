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
  GET_THREAD_STATUS_TOOL_DESCRIPTION,
  RENAME_THREAD_TOOL_DESCRIPTION,
} from "./threadOrchestrationBridge.shared.ts";
import {
  COMPUTER_USE_TOOL_DESCRIPTION,
  COPILOT_COMPUTER_USE_PARAMETERS,
} from "./orchestrationComputerUseTool.shared.ts";
import { BROWSER_TOOL_PARAMETERS } from "./orchestrationBrowserTool.shared.ts";
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
  readonly computerUse: (action: ComputerUseActionType) => Promise<Record<string, unknown>>;
  readonly browser: (action: BrowserActionType) => Promise<Record<string, unknown>>;
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
