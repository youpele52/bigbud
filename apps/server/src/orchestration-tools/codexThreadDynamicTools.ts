import { ComputerUseAction, ThreadId, type ComputerUseResult } from "@bigbud/contracts";
import { Effect, Schema } from "effect";

import type {
  CodexDynamicToolCallHandler,
  CodexDynamicToolCallResult,
  CodexDynamicToolSpec,
} from "../codex/codexAppServerManager.types.ts";
import type { ThreadOrchestrationToolDispatcherShape } from "./ThreadOrchestrationToolDispatcher.ts";
import { getThreadOrchestrationToolDispatcher } from "./ThreadOrchestrationToolDispatcher.ts";
import {
  ARCHIVE_THREAD_TOOL_DESCRIPTION,
  COMPUTER_USE_TOOL_DESCRIPTION,
  GET_THREAD_STATUS_TOOL_DESCRIPTION,
  RENAME_THREAD_TOOL_DESCRIPTION,
} from "./threadOrchestrationBridge.shared.ts";
import { COPILOT_COMPUTER_USE_PARAMETERS } from "./orchestrationComputerUseTool.shared.ts";

const BIGBUD_ORCHESTRATION_NAMESPACE = "bigbud_orchestration";
const decodeComputerUseAction = Schema.decodeUnknownSync(ComputerUseAction);

function inputText(text: string): CodexDynamicToolCallResult["contentItems"][number] {
  return { type: "inputText", text };
}

function inputImage(
  result: ComputerUseResult,
): CodexDynamicToolCallResult["contentItems"][number] | null {
  const screenshot = result.screenshot;
  if (!screenshot?.mimeType || !screenshot.dataBase64) {
    return null;
  }
  return {
    type: "inputImage",
    imageUrl: `data:${screenshot.mimeType};base64,${screenshot.dataBase64}`,
  };
}

function requireDispatcher(): ThreadOrchestrationToolDispatcherShape {
  const dispatcher = getThreadOrchestrationToolDispatcher();
  if (!dispatcher) {
    throw new Error("Thread orchestration tools are not ready.");
  }
  return dispatcher;
}

export function createCodexThreadOrchestrationDynamicTools(): ReadonlyArray<CodexDynamicToolSpec> {
  return [
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "rename_thread",
      description: RENAME_THREAD_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "New thread title" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "archive_thread",
      description: ARCHIVE_THREAD_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      namespace: BIGBUD_ORCHESTRATION_NAMESPACE,
      name: "get_thread_status",
      description: GET_THREAD_STATUS_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread ID to inspect" },
        },
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

export function createCodexThreadOrchestrationDynamicToolHandler(
  threadId: ThreadId,
): CodexDynamicToolCallHandler {
  return async ({ namespace, tool, arguments: args }) => {
    if (namespace !== BIGBUD_ORCHESTRATION_NAMESPACE) {
      throw new Error(`Unsupported dynamic tool namespace: ${namespace ?? "<none>"}`);
    }

    const dispatcher = requireDispatcher();

    switch (tool) {
      case "rename_thread": {
        const argRecord =
          args && typeof args === "object" ? (args as Record<string, unknown>) : null;
        const title = typeof argRecord?.title === "string" ? argRecord.title.trim() : "";
        if (title.length === 0) {
          throw new Error("Thread title cannot be empty.");
        }
        const result = await Effect.runPromise(dispatcher.rename({ threadId, title }));
        return {
          contentItems: [inputText(`Renamed thread to "${result.title}".`)],
          success: true,
        };
      }
      case "archive_thread": {
        await Effect.runPromise(dispatcher.archive({ threadId }));
        return {
          contentItems: [inputText("Archived the current thread.")],
          success: true,
        };
      }
      case "get_thread_status": {
        const argRecord =
          args && typeof args === "object" ? (args as Record<string, unknown>) : null;
        const targetThreadId =
          typeof argRecord?.threadId === "string" ? argRecord.threadId.trim() : "";
        if (targetThreadId.length === 0) {
          throw new Error("Thread ID is required.");
        }
        const status = await Effect.runPromise(
          dispatcher.getStatus({
            callerThreadId: threadId,
            threadId: ThreadId.makeUnsafe(targetThreadId),
          }),
        );
        return {
          contentItems: [inputText(JSON.stringify(status, null, 2))],
          success: true,
        };
      }
      case "computer_use": {
        const action = decodeComputerUseAction(args);
        const result = await Effect.runPromise(dispatcher.computerUse({ threadId, action }));
        return {
          contentItems: [
            inputText(JSON.stringify(result, null, 2)),
            ...[inputImage(result)].flatMap((item) => (item ? [item] : [])),
          ],
          success: true,
        };
      }
      default:
        throw new Error(`Unsupported dynamic tool: ${tool}`);
    }
  };
}
