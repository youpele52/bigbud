/** ClaudeAdapter SDK message dispatchers. Routes raw SDK messages to specialized handlers. @module ClaudeAdapter.stream.handlers */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type EventId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  asCanonicalTurnId,
  asRuntimeItemId,
  classifyToolItemType,
  extractPlanStepsFromTodoInput,
  isTodoTool,
  nativeProviderRefs,
  streamKindFromDeltaType,
  summarizeToolRequest,
  titleForTool,
  toolInputFingerprint,
  tryParseJsonRecord,
} from "./Adapter.utils.ts";
import type {
  AssistantTextBlockState,
  ClaudeSessionContext,
  ToolInFlight,
} from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { BlockHandlers } from "./Adapter.stream.blocks.ts";
import { makeMessageSpecificHandlers } from "./Adapter.stream.handlers.messages.ts";
import type { TurnHandlers } from "./Adapter.stream.turn.ts";
import { makeSystemHandlers } from "./Adapter.stream.system.ts";

export interface MessageHandlerDeps {
  readonly makeEventStamp: () => Effect.Effect<{
    eventId: EventId;
    createdAt: string;
  }>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly nowIso: Effect.Effect<string>;
  readonly blocks: BlockHandlers;
  readonly turn: TurnHandlers;
}

export const makeMessageHandlers = (deps: MessageHandlerDeps) => {
  const { makeEventStamp, offerRuntimeEvent, nowIso, blocks, turn } = deps;

  const systemHandlers = makeSystemHandlers({ makeEventStamp, offerRuntimeEvent, turn });
  const messageSpecificHandlers = makeMessageSpecificHandlers({
    makeEventStamp,
    offerRuntimeEvent,
    nowIso,
    blocks,
    turn,
  });

  const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "stream_event") {
      return;
    }

    const { event } = message;

    if (event.type === "content_block_delta") {
      if (
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
        context.turnState
      ) {
        const deltaText =
          event.delta.type === "text_delta"
            ? event.delta.text
            : typeof event.delta.thinking === "string"
              ? event.delta.thinking
              : "";
        if (deltaText.length === 0) {
          return;
        }
        const streamKind = streamKindFromDeltaType(event.delta.type);
        const assistantBlockEntry =
          event.delta.type === "text_delta"
            ? yield* blocks.ensureAssistantTextBlock(context, event.index)
            : context.turnState.assistantTextBlocks.get(event.index)
              ? {
                  blockIndex: event.index,
                  block: context.turnState.assistantTextBlocks.get(
                    event.index,
                  ) as AssistantTextBlockState,
                }
              : undefined;
        if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
          assistantBlockEntry.block.emittedTextDelta = true;
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          ...(assistantBlockEntry?.block
            ? { itemId: asRuntimeItemId(assistantBlockEntry.block.itemId) }
            : {}),
          payload: {
            streamKind,
            delta: deltaText,
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta",
            payload: message,
          },
        });
        return;
      }

      if (event.delta.type === "input_json_delta") {
        const tool = context.inFlightTools.get(event.index);
        if (!tool || typeof event.delta.partial_json !== "string") {
          return;
        }

        const partialInputJson = tool.partialInputJson + event.delta.partial_json;
        const parsedInput = tryParseJsonRecord(partialInputJson);
        const detail = parsedInput ? summarizeToolRequest(tool.toolName, parsedInput) : tool.detail;
        let nextTool: ToolInFlight = {
          ...tool,
          partialInputJson,
          ...(parsedInput ? { input: parsedInput } : {}),
          ...(detail ? { detail } : {}),
        };

        const nextFingerprint =
          parsedInput && Object.keys(parsedInput).length > 0
            ? toolInputFingerprint(parsedInput)
            : undefined;
        context.inFlightTools.set(event.index, nextTool);

        if (
          !parsedInput ||
          !nextFingerprint ||
          tool.lastEmittedInputFingerprint === nextFingerprint
        ) {
          return;
        }

        nextTool = {
          ...nextTool,
          lastEmittedInputFingerprint: nextFingerprint,
        };
        context.inFlightTools.set(event.index, nextTool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          itemId: asRuntimeItemId(nextTool.itemId),
          payload: {
            itemType: nextTool.itemType,
            status: "inProgress",
            title: nextTool.title,
            ...(nextTool.detail ? { detail: nextTool.detail } : {}),
            data: {
              toolName: nextTool.toolName,
              input: nextTool.input,
            },
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: nextTool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta/input_json_delta",
            payload: message,
          },
        });

        if (isTodoTool(nextTool.toolName) && parsedInput) {
          const planSteps = extractPlanStepsFromTodoInput(parsedInput);
          if (planSteps.length > 0 && context.turnState) {
            const planStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "turn.plan.updated",
              eventId: planStamp.eventId,
              provider: PROVIDER,
              createdAt: planStamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              payload: {
                plan: planSteps,
              },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: nextTool.itemId,
              }),
            });
          }
        }
      }
      return;
    }

    if (event.type === "content_block_start") {
      const { index, content_block: block } = event;
      if (block.type === "text") {
        yield* blocks.ensureAssistantTextBlock(context, index, {
          fallbackText: blocks.getContentBlockText(block),
        });
        return;
      }
      if (
        block.type !== "tool_use" &&
        block.type !== "server_tool_use" &&
        block.type !== "mcp_tool_use"
      ) {
        return;
      }

      const toolName = block.name;
      const itemType = classifyToolItemType(toolName);
      const toolInput =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const itemId = block.id;
      const detail = summarizeToolRequest(toolName, toolInput);
      const inputFingerprint =
        Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

      const tool: ToolInFlight = {
        itemId,
        itemType,
        toolName,
        title: titleForTool(itemType),
        detail,
        input: toolInput,
        partialInputJson: "",
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
      };
      context.inFlightTools.set(index, tool);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: toolInput,
          },
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/stream_event/content_block_start",
          payload: message,
        },
      });
      return;
    }

    if (event.type === "content_block_stop") {
      const { index } = event;
      const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
      if (assistantBlock) {
        assistantBlock.streamClosed = true;
        yield* blocks.completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const tool = context.inFlightTools.get(index);
      if (!tool) {
        return;
      }

      if (isTodoTool(tool.toolName) && tool.input && typeof tool.input === "object") {
        const planSteps = extractPlanStepsFromTodoInput(tool.input as Record<string, unknown>);
        if (planSteps.length > 0 && context.turnState) {
          const planStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.plan.updated",
            eventId: planStamp.eventId,
            provider: PROVIDER,
            createdAt: planStamp.createdAt,
            threadId: context.session.threadId,
            turnId: context.turnState.turnId,
            payload: {
              plan: planSteps,
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
          });
        }
      }
    }
  });

  const { handleAssistantMessage, handleUserMessage } = messageSpecificHandlers;

  const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* turn.ensureThreadId(context, message);

    switch (message.type) {
      case "stream_event":
        yield* handleStreamEvent(context, message);
        return;
      case "user":
        yield* handleUserMessage(context, message);
        return;
      case "assistant":
        yield* handleAssistantMessage(context, message);
        return;
      case "result":
        yield* turn.handleResultMessage(context, message);
        return;
      case "system":
        yield* systemHandlers.handleSystemMessage(context, message);
        return;
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "rate_limit_event":
        yield* systemHandlers.handleSdkTelemetryMessage(context, message);
        return;
      default:
        yield* turn.emitRuntimeWarning(
          context,
          `Unhandled Claude SDK message type '${message.type}'.`,
          message,
        );
        return;
    }
  });

  return {
    handleStreamEvent,
    handleUserMessage,
    handleAssistantMessage,
    handleSdkMessage,
  };
};

export type MessageHandlers = ReturnType<typeof makeMessageHandlers>;
