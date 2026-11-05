import type { Tool } from "@github/copilot-sdk";
import {
  HTML_RENDER_TOOL_DESCRIPTION,
  HTML_RENDER_TOOL_PARAMETERS,
} from "./htmlRenderTool.shared.ts";
import {
  SYSTEM_RESOURCE_READ_PARAMETERS,
  SYSTEM_RESOURCE_RULE_PARAMETERS,
  CONFIGURE_SYSTEM_RESOURCE_RULES_DESCRIPTION,
} from "./systemResourceTools.shared.ts";
import {
  BrowserAction,
  type BrowserAction as BrowserActionType,
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
  computerUseToolDescription,
  computerUseToolParameters,
} from "./orchestrationComputerUseTool.selected.ts";
import {
  decodeComputerUseToolRequest,
  unroutedComputerUseV2Result,
  type ComputerUseV2ToolRequest,
} from "./computerUseToolRequest.ts";
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
import {
  MOVE_THREAD_TOOL_DESCRIPTION,
  MOVE_THREAD_TOOL_PARAMETERS,
  SNOOZE_THREAD_TOOL_DESCRIPTION,
  SNOOZE_THREAD_TOOL_PARAMETERS,
} from "./threadOrganizationTool.shared.ts";
import type { ThreadOrganizationToolName } from "./threadOrganizationTool.run.ts";

function createCopilotOrganizationTools(
  organizeThread: (
    name: ThreadOrganizationToolName,
    args: unknown,
    invocationId: string,
  ) => Promise<unknown>,
): ReadonlyArray<Tool<Record<string, unknown>>> {
  const specs = [
    ["move_thread", MOVE_THREAD_TOOL_DESCRIPTION, MOVE_THREAD_TOOL_PARAMETERS],
    ["snooze_thread", SNOOZE_THREAD_TOOL_DESCRIPTION, SNOOZE_THREAD_TOOL_PARAMETERS],
  ] as const;
  return specs.map(([name, description, parameters]) => ({
    name,
    description,
    parameters,
    handler: async (args, invocation) => {
      try {
        const result = await organizeThread(name, args, invocation.toolCallId);
        return successResult(JSON.stringify(result, null, 2));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : `Failed to run ${name}.`);
      }
    },
  }));
}

export function createCopilotThreadOrchestrationTools(
  input: CopilotThreadToolsInput & {
    readonly renderHtml?: (args: unknown, invocationId: string) => Promise<unknown>;
    readonly getSystemResources?: (input?: unknown) => Promise<Record<string, unknown>>;
    readonly configureSystemResourceRules?: (input: unknown) => Promise<Record<string, unknown>>;
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
    /** Inyosira `move_thread` / `snooze_thread`; absent until organization is installed. */
    readonly organizeThread?: (
      name: ThreadOrganizationToolName,
      args: unknown,
      invocationId: string,
    ) => Promise<unknown>;
    readonly computerUse: (action: ComputerUseActionType) => Promise<Record<string, unknown>>;
    /** v2 desktop requests; absent means they fail closed (`control_unavailable`). */
    readonly computerUseV2?: (
      request: ComputerUseV2ToolRequest,
    ) => Promise<Record<string, unknown>>;
    readonly browser: (action: BrowserActionType) => Promise<Record<string, unknown>>;
  },
): ReadonlyArray<Tool<{ title?: string; threadId?: string } & Record<string, unknown>>> {
  const decodeBrowserAction = Schema.decodeUnknownSync(BrowserAction);
  return [
    {
      name: "render_html",
      description: HTML_RENDER_TOOL_DESCRIPTION,
      parameters: HTML_RENDER_TOOL_PARAMETERS,
      handler: async (args, invocation) => {
        try {
          if (!input.renderHtml) throw new Error("HTML rendering is not ready.");
          return successResult(JSON.stringify(await input.renderHtml(args, invocation.toolCallId)));
        } catch (error) {
          return failureResult(error instanceof Error ? error.message : "HTML publication failed.");
        }
      },
    },
    ...(input.workspace ? createCopilotAgentWorkspaceTools(input.workspace) : []),
    {
      name: "get_system_resources",
      description: GET_SYSTEM_RESOURCES_TOOL_DESCRIPTION,
      parameters: SYSTEM_RESOURCE_READ_PARAMETERS,
      handler: async (args) => {
        try {
          const result = input.getSystemResources
            ? await input.getSystemResources(args ?? {})
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
      name: "configure_system_resource_rules",
      description: CONFIGURE_SYSTEM_RESOURCE_RULES_DESCRIPTION,
      parameters: SYSTEM_RESOURCE_RULE_PARAMETERS,
      handler: async (args) => {
        try {
          if (!input.configureSystemResourceRules) throw new Error("monitor settings unavailable");
          return successResult(JSON.stringify(await input.configureSystemResourceRules(args)));
        } catch (error) {
          return failureResult(
            error instanceof Error ? error.message : "monitor settings unavailable",
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
    ...(input.organizeThread ? createCopilotOrganizationTools(input.organizeThread) : []),
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
      description: computerUseToolDescription(),
      parameters: computerUseToolParameters(),
      handler: async (args) => {
        try {
          const request = decodeComputerUseToolRequest(args);
          const result =
            request.kind === "legacy"
              ? await input.computerUse(request.action)
              : input.computerUseV2
                ? await input.computerUseV2(request)
                : unroutedComputerUseV2Result(request);
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
