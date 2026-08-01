import { randomUUID } from "node:crypto";

import {
  BrowserAction,
  ComputerUseAction,
  MessageId,
  ProjectId,
  ThreadId,
  type BrowserResult,
  type ComputerUseResult,
} from "@bigbud/contracts";
import { Effect, Schema } from "effect";

import type {
  CodexDynamicToolCallHandler,
  CodexDynamicToolCallResult,
} from "../codex/codexAppServerManager.types.ts";
import type { ThreadOrchestrationToolDispatcherShape } from "./ThreadOrchestrationToolDispatcher.ts";
import { getThreadOrchestrationToolDispatcher } from "./ThreadOrchestrationToolDispatcher.ts";
import {
  readCapabilityGuide,
  searchCapabilities,
  type CapabilityGuideSection,
} from "../capabilities/CapabilityCatalog.operations.ts";
import { getEffectiveCapabilityCatalog } from "../capabilities/CapabilityCatalog.dynamic.ts";
import { BIGBUD_ORCHESTRATION_NAMESPACE } from "./codexThreadDynamicTools.specs.ts";
import { normalizeListThreadsStatus } from "./ThreadOrchestrationTools.listThreads.ts";

export { createCodexThreadOrchestrationDynamicTools } from "./codexThreadDynamicTools.specs.ts";

const decodeComputerUseAction = Schema.decodeUnknownSync(ComputerUseAction);
const decodeBrowserAction = Schema.decodeUnknownSync(BrowserAction);

function inputText(text: string): CodexDynamicToolCallResult["contentItems"][number] {
  return { type: "inputText", text };
}

function inputImage(
  result: Pick<ComputerUseResult | BrowserResult, "screenshot">,
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

export function createCodexThreadOrchestrationDynamicToolHandler(
  threadId: ThreadId,
  sourceMessageId: MessageId = MessageId.makeUnsafe(randomUUID()),
): CodexDynamicToolCallHandler {
  return async ({
    namespace,
    tool,
    arguments: args,
    requestId,
    sourceMessageId: requestSource,
  }) => {
    if (namespace !== BIGBUD_ORCHESTRATION_NAMESPACE) {
      throw new Error(`Unsupported dynamic tool namespace: ${namespace ?? "<none>"}`);
    }

    const dispatcher = requireDispatcher();
    const capabilityCatalog = getEffectiveCapabilityCatalog(threadId);

    switch (tool) {
      case "search_capabilities": {
        const argRecord =
          args && typeof args === "object" ? (args as Record<string, unknown>) : null;
        const query = typeof argRecord?.query === "string" ? argRecord.query : "";
        return {
          contentItems: [
            inputText(JSON.stringify(searchCapabilities(query, capabilityCatalog), null, 2)),
          ],
          success: true,
        };
      }
      case "read_capability_guide": {
        const argRecord =
          args && typeof args === "object" ? (args as Record<string, unknown>) : null;
        const capabilityId =
          typeof argRecord?.capabilityId === "string" ? argRecord.capabilityId.trim() : "";
        if (capabilityId.length === 0) {
          throw new Error("Capability ID is required.");
        }
        const section =
          typeof argRecord?.section === "string"
            ? (argRecord.section as CapabilityGuideSection)
            : undefined;
        return {
          contentItems: [
            inputText(
              JSON.stringify(
                readCapabilityGuide({
                  capabilityId,
                  ...(capabilityCatalog ? { catalog: capabilityCatalog } : {}),
                  ...(section ? { section } : {}),
                }),
                null,
                2,
              ),
            ),
          ],
          success: true,
        };
      }
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
      case "create_thread": {
        const argRecord =
          args && typeof args === "object" ? (args as Record<string, unknown>) : null;
        const title = typeof argRecord?.title === "string" ? argRecord.title.trim() : "";
        const task = typeof argRecord?.task === "string" ? argRecord.task.trim() : "";
        if (title.length === 0) {
          throw new Error("Thread title cannot be empty.");
        }
        if (task.length === 0) {
          throw new Error("Thread task cannot be empty.");
        }
        const projectId =
          typeof argRecord?.projectId === "string" ? argRecord.projectId.trim() : "";
        const result = await Effect.runPromise(
          dispatcher.createThread
            ? dispatcher.createThread({
                callerThreadId: threadId,
                sourceMessageId: MessageId.makeUnsafe(requestSource ?? sourceMessageId),
                invocationId: String(requestId),
                title,
                task,
                ...(projectId ? { projectId: ProjectId.makeUnsafe(projectId) } : {}),
                watchForCompletion: argRecord?.watchForCompletion === true,
              })
            : Effect.fail(new Error("Thread creation is not ready.")),
        );
        return {
          contentItems: [inputText(JSON.stringify(result, null, 2))],
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
      case "send_thread_message": {
        const argRecord =
          args && typeof args === "object" ? (args as Record<string, unknown>) : null;
        const targetThreadId =
          typeof argRecord?.threadId === "string" ? argRecord.threadId.trim() : "";
        const message = typeof argRecord?.message === "string" ? argRecord.message.trim() : "";
        if (!targetThreadId || !message) throw new Error("Thread ID and message are required.");
        const delivery = argRecord?.delivery === "queue" ? "queue" : "auto";
        const result = await Effect.runPromise(
          dispatcher.sendMessage
            ? dispatcher.sendMessage({
                callerThreadId: threadId,
                threadId: ThreadId.makeUnsafe(targetThreadId),
                message,
                delivery,
                invocationId: String(requestId),
              })
            : Effect.fail(new Error("Thread messaging is not ready.")),
        );
        return { contentItems: [inputText(JSON.stringify(result, null, 2))], success: true };
      }
      case "list_threads": {
        const argRecord =
          args && typeof args === "object" ? (args as Record<string, unknown>) : null;
        const projectId =
          typeof argRecord?.projectId === "string" ? argRecord.projectId.trim() : "";
        const result = await Effect.runPromise(
          dispatcher.listThreads
            ? dispatcher.listThreads({
                callerThreadId: threadId,
                ...(projectId ? { projectId: ProjectId.makeUnsafe(projectId) } : {}),
                status: normalizeListThreadsStatus(argRecord?.status),
                ...(typeof argRecord?.limit === "number" ? { limit: argRecord.limit } : {}),
                includeExcerpt: argRecord?.includeExcerpt === true,
              })
            : Effect.fail(new Error("Thread listing is not ready.")),
        );
        return { contentItems: [inputText(JSON.stringify(result, null, 2))], success: true };
      }
      case "list_pinned_threads": {
        const result = await Effect.runPromise(dispatcher.listPinned({ callerThreadId: threadId }));
        return {
          contentItems: [inputText(JSON.stringify(result, null, 2))],
          success: true,
        };
      }
      case "pin_thread":
      case "unpin_thread": {
        const argRecord =
          args && typeof args === "object" ? (args as Record<string, unknown>) : null;
        const targetThreadId =
          typeof argRecord?.threadId === "string" ? argRecord.threadId.trim() : "";
        if (targetThreadId.length === 0) {
          throw new Error("Thread ID is required.");
        }
        const result = await Effect.runPromise(
          dispatcher.setPinned({
            callerThreadId: threadId,
            threadId: ThreadId.makeUnsafe(targetThreadId),
            pinned: tool === "pin_thread",
          }),
        );
        return {
          contentItems: [inputText(JSON.stringify(result, null, 2))],
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
      case "browser": {
        const action = decodeBrowserAction(args);
        const result = await Effect.runPromise(dispatcher.browser({ threadId, action }));
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
