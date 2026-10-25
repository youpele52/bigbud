import type { Tool } from "@github/copilot-sdk";
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
  GET_SYSTEM_RESOURCES_TOOL_DESCRIPTION,
  RENAME_THREAD_TOOL_DESCRIPTION,
} from "./threadOrchestrationBridge.shared.ts";
import {
  COMPUTER_USE_TOOL_DESCRIPTION,
  COPILOT_COMPUTER_USE_PARAMETERS,
} from "./orchestrationComputerUseTool.shared.ts";
import { BROWSER_TOOL_PARAMETERS } from "./orchestrationBrowserTool.shared.ts";
import {
  createCopilotThreadDelegationTools,
  createCopilotThreadMessagingTools,
  type CopilotThreadToolsInput,
} from "./copilotThreadOrchestrationTools.threads.ts";
import { failureResult, successResult } from "./copilotThreadOrchestrationTools.results.ts";
import {
  BIGBUD_PLAN_TRACKING_TOOL_DESCRIPTION,
  BIGBUD_PLAN_TRACKING_TOOL_NAME,
  BIGBUD_PLAN_TRACKING_TOOL_PARAMETERS,
  BIGBUD_PLAN_TRACKING_TOOL_SUCCESS_MESSAGE,
} from "./threadPlanTrackingTool.shared.ts";
import type { AgentWorkspaceToolName } from "./AgentWorkspaceTools.ts";
import { createCopilotAgentWorkspaceTools } from "./copilotAgentWorkspaceTools.ts";
import { RenameThreadArguments, RENAME_THREAD_TOOL_PARAMETERS } from "./threadRenameTool.shared.ts";

export function createCopilotThreadOrchestrationTools(
  input: CopilotThreadToolsInput & {
    readonly getSystemResources?: () => Promise<Record<string, unknown>>;
    readonly workspace?: (
      tool: AgentWorkspaceToolName,
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    readonly renameThread: (
      title: string,
      targetThreadId?: string,
      invocationId?: string,
    ) => Promise<{ readonly title: string }>;
    readonly archiveThread: () => Promise<void>;
    readonly computerUse: (action: ComputerUseActionType) => Promise<Record<string, unknown>>;
    readonly browser: (action: BrowserActionType) => Promise<Record<string, unknown>>;
  },
): ReadonlyArray<Tool<{ title?: string; threadId?: string } & Record<string, unknown>>> {
  const decodeComputerUseAction = Schema.decodeUnknownSync(ComputerUseAction);
  const decodeBrowserAction = Schema.decodeUnknownSync(BrowserAction);
  return [
    ...(input.workspace ? createCopilotAgentWorkspaceTools(input.workspace) : []),
    {
      name: "get_system_resources",
      description: GET_SYSTEM_RESOURCES_TOOL_DESCRIPTION,
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      handler: async () => {
        try {
          const result = input.getSystemResources
            ? await input.getSystemResources()
            : { available: false, reason: "desktop monitor unavailable" };
          return successResult(JSON.stringify(result, null, 2));
        } catch {
          return successResult(
            JSON.stringify({ available: false, reason: "desktop monitor unavailable" }),
          );
        }
      },
    },
    {
      name: "rename_thread",
      description: RENAME_THREAD_TOOL_DESCRIPTION,
      parameters: RENAME_THREAD_TOOL_PARAMETERS,
      handler: async (args, invocation) => {
        try {
          const { title, targetThreadId } = Schema.decodeUnknownSync(RenameThreadArguments)(args);
          const result = await input.renameThread(title, targetThreadId, invocation.toolCallId);
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
    ...createCopilotThreadDelegationTools(input),
    {
      name: BIGBUD_PLAN_TRACKING_TOOL_NAME,
      description: BIGBUD_PLAN_TRACKING_TOOL_DESCRIPTION,
      parameters: BIGBUD_PLAN_TRACKING_TOOL_PARAMETERS,
      handler: async () => successResult(BIGBUD_PLAN_TRACKING_TOOL_SUCCESS_MESSAGE),
    },
    {
      name: "browser",
      // Native tool discovery must not use the model-reserved browser namespace.
      namespace: { name: "bigbud_browser", description: "Browser automation provided by bigbud" },
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
    ...createCopilotThreadMessagingTools(input),
  ];
}
