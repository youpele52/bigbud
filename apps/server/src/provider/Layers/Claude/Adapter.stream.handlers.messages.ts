import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type EventId, TurnId } from "@bigbud/contracts";
import { Effect, Random } from "effect";

import {
  asCanonicalTurnId,
  asRuntimeItemId,
  extractExitPlanModePlan,
  nativeProviderRefs,
  tryParseJsonRecord,
  toolResultBlocksFromUserMessage,
  toolResultStreamKind,
} from "./Adapter.utils.ts";
import type { ClaudeSessionContext, UnstampedProviderRuntimeEvent } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { BlockHandlers } from "./Adapter.stream.blocks.ts";
import { asRecord, decodeClaudeUserToolResult } from "./Adapter.sdk.messages.ts";
import { claudeSdkDiagnostic, claudeSdkRuntimeRaw } from "./Adapter.sdk.projections.ts";
import { updateClaudeTaskPlan } from "./Adapter.stream.tasks.ts";
import { taskCreateResultId } from "./Adapter.tasks.reducer.parse.ts";
import type { TurnHandlers } from "./Adapter.stream.turn.ts";

interface MessageSpecificHandlerDeps {
  readonly makeEventStamp: () => Effect.Effect<{
    eventId: EventId;
    createdAt: string;
  }>;
  readonly offerRuntimeEvent: (event: UnstampedProviderRuntimeEvent) => Effect.Effect<void>;
  readonly nowIso: Effect.Effect<string>;
  readonly blocks: BlockHandlers;
  readonly turn: TurnHandlers;
}

export const makeMessageSpecificHandlers = (deps: MessageSpecificHandlerDeps) => {
  const { makeEventStamp, offerRuntimeEvent, nowIso, blocks, turn } = deps;

  const handleUserMessage = Effect.fn("handleUserMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "user") {
      return;
    }

    if (message.uuid) {
      context.queuedUserMessageIds.delete(message.uuid);
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
    }
    const userToolResult = decodeClaudeUserToolResult(message);

    for (const toolResult of toolResultBlocksFromUserMessage(message)) {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );
      if (!toolEntry) {
        continue;
      }

      const [index, tool] = toolEntry;
      const itemStatus = toolResult.isError ? "failed" : "completed";
      const toolData = {
        toolName: tool.toolName,
        input: tool.input,
        result: {
          isError: toolResult.isError,
          hasStructuredResult: userToolResult.hasStructuredResult,
        },
      };

      const updatedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: toolResult.isError ? "failed" : "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: claudeSdkRuntimeRaw(message, "claude/user"),
      });

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind && toolResult.text.length > 0 && context.turnState) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
          raw: claudeSdkRuntimeRaw(message, "claude/user"),
        });
      }

      const completedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: claudeSdkRuntimeRaw(message, "claude/user"),
      });

      const result = asRecord(message.tool_use_result) ?? tryParseJsonRecord(toolResult.text);
      const createdTaskId =
        tool.toolName === "TaskCreate" && !toolResult.isError
          ? taskCreateResultId(message.tool_use_result, toolResult.text)
          : undefined;
      const taskResult =
        tool.toolName === "TaskCreate"
          ? createdTaskId
            ? { ...tool.input, task_id: createdTaskId }
            : toolResult.isError
              ? { status: "deleted" }
              : undefined
          : result;
      const isTaskListSnapshot = tool.toolName === "TaskList" && Array.isArray(result?.tasks);
      if (taskResult && (tool.toolName !== "TaskList" || isTaskListSnapshot)) {
        yield* updateClaudeTaskPlan({
          context,
          toolUseId: tool.itemId,
          toolName: tool.toolName,
          input: taskResult,
          ...(isTaskListSnapshot ? { authoritativeSnapshot: true } : {}),
          now: yield* nowIso,
          makeEventStamp,
          offerRuntimeEvent,
        });
      }

      context.inFlightTools.delete(index);
    }
  });

  const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "assistant") {
      return;
    }

    if (message.parent_tool_use_id) {
      const summary = Array.isArray(message.message?.content)
        ? message.message.content
            .flatMap((block) => {
              const text = asRecord(block)?.text;
              return typeof text === "string" && text.length > 0 ? [text] : [];
            })
            .join("\n")
        : "";
      if (summary.length > 0) {
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "tool.progress",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          payload: {
            toolUseId: message.parent_tool_use_id,
            ...(message.subagent_type ? { toolName: message.subagent_type } : {}),
            summary,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: message.parent_tool_use_id,
          }),
          raw: claudeSdkRuntimeRaw(message, "claude/assistant/subagent"),
        });
      }
      return;
    }

    if (!context.turnState) {
      const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
      const startedAt = yield* nowIso;
      context.turnState = {
        turnId,
        synthetic: true,
        startedAt,
        items: [],
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        nextSyntheticAssistantBlockIndex: -1,
      };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {
          ...nativeProviderRefs(context),
          providerTurnId: turnId,
        },
        raw: {
          source: "claude.sdk.message",
          method: "claude/synthetic-turn-start",
          payload: {},
        },
      });
    }

    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const toolUse = asRecord(block);
        if (toolUse?.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
          continue;
        }
        const planMarkdown = extractExitPlanModePlan(toolUse.input);
        if (!planMarkdown) {
          continue;
        }
        yield* turn.emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
          rawSource: "claude.sdk.message",
          rawMethod: "claude/assistant",
          rawPayload: claudeSdkDiagnostic(message),
        });
      }
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
      yield* blocks.backfillAssistantTextBlocksFromSnapshot(context, message);
    }

    context.lastAssistantUuid = message.uuid;
    yield* turn.updateResumeCursor(context);
  });

  return {
    handleAssistantMessage,
    handleUserMessage,
  };
};
