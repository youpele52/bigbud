import { randomUUID } from "node:crypto";

import { EventId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ActivePiSession, PiEmitEvents } from "./Adapter.types.ts";
import {
  classifyToolItemType,
  eventBase,
  isRecord,
  normalizeString,
  normalizeUsage,
  titleForTool,
} from "./Adapter.utils.ts";
export { handleExtensionUiRequest } from "./Adapter.stream.handlers.userInput.ts";

export function emitWithTurnAppend(deps: {
  readonly emit: PiEmitEvents;
  readonly session: ActivePiSession;
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
}) {
  return deps.events.length === 0
    ? Effect.void
    : Effect.sync(() => {
        const turnId = deps.session.activeTurnId;
        const turn = turnId
          ? (deps.session.turns.find((entry) => entry.id === turnId) ?? deps.session.turns.at(-1))
          : deps.session.turns.at(-1);
        if (turn) {
          turn.items.push(...deps.events);
        }
      }).pipe(Effect.andThen(deps.emit(deps.events)));
}

export const handleToolExecutionStart = Effect.fn("handleToolExecutionStart")(function* (deps: {
  readonly emit: PiEmitEvents;
  readonly session: ActivePiSession;
  readonly stamp: { eventId: EventId; createdAt: string };
  readonly raw: NonNullable<ProviderRuntimeEvent["raw"]>;
  readonly message: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args?: Record<string, unknown>;
  };
}) {
  const toolName = normalizeString(deps.message.toolName) ?? "Tool";
  const itemType = classifyToolItemType(toolName);
  const title = titleForTool(itemType);
  deps.session.currentToolInfoById.set(deps.message.toolCallId, {
    toolName,
    args: deps.message.args,
    itemType,
    title,
  });
  deps.session.currentToolOutputById.set(deps.message.toolCallId, "");

  yield* emitWithTurnAppend({
    emit: deps.emit,
    session: deps.session,
    events: [
      {
        ...eventBase({
          eventId: deps.stamp.eventId,
          createdAt: deps.stamp.createdAt,
          threadId: deps.session.threadId,
          ...(deps.session.activeTurnId ? { turnId: deps.session.activeTurnId } : {}),
          itemId: deps.message.toolCallId,
          raw: deps.raw,
        }),
        type: "item.started",
        payload: {
          itemType,
          status: "inProgress",
          title,
          ...(deps.message.args ? { data: deps.message.args } : {}),
        },
      },
    ],
  });
});

function extractToolResultText(partialResult: unknown): string | undefined {
  if (typeof partialResult === "string") {
    return partialResult.length > 0 ? partialResult : undefined;
  }
  if (!isRecord(partialResult)) {
    return undefined;
  }
  const content = partialResult.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const chunks = content
    .flatMap((part): string[] => {
      if (isRecord(part) && typeof part.text === "string") {
        return [part.text];
      }
      return [];
    })
    .filter((part) => part.length > 0);
  return chunks.length > 0 ? chunks.join("") : undefined;
}

export const handleToolExecutionUpdate = Effect.fn("handleToolExecutionUpdate")(function* (deps: {
  readonly emit: PiEmitEvents;
  readonly session: ActivePiSession;
  readonly stamp: { eventId: EventId; createdAt: string };
  readonly raw: NonNullable<ProviderRuntimeEvent["raw"]>;
  readonly message: {
    readonly toolCallId: string;
    readonly partialResult?: import("./RpcProcess.ts").PiRpcToolResult;
  };
}) {
  const partialResult = extractToolResultText(deps.message.partialResult);
  if (!partialResult) {
    return;
  }
  const previous = deps.session.currentToolOutputById.get(deps.message.toolCallId) ?? "";
  const delta = partialResult.startsWith(previous)
    ? partialResult.slice(previous.length)
    : partialResult;
  deps.session.currentToolOutputById.set(deps.message.toolCallId, partialResult);
  if (delta.length === 0) {
    return;
  }
  const toolInfo = deps.session.currentToolInfoById.get(deps.message.toolCallId);
  const streamKind = toolInfo?.itemType === "command_execution" ? "command_output" : "unknown";
  yield* emitWithTurnAppend({
    emit: deps.emit,
    session: deps.session,
    events: [
      {
        ...eventBase({
          eventId: deps.stamp.eventId,
          createdAt: deps.stamp.createdAt,
          threadId: deps.session.threadId,
          ...(deps.session.activeTurnId ? { turnId: deps.session.activeTurnId } : {}),
          itemId: deps.message.toolCallId,
          raw: deps.raw,
        }),
        type: "content.delta",
        payload: {
          streamKind,
          delta,
        },
      },
    ],
  });
});

export const handleToolExecutionEnd = Effect.fn("handleToolExecutionEnd")(function* (deps: {
  readonly emit: PiEmitEvents;
  readonly session: ActivePiSession;
  readonly stamp: { eventId: EventId; createdAt: string };
  readonly raw: NonNullable<ProviderRuntimeEvent["raw"]>;
  readonly message: {
    readonly toolCallId: string;
    readonly result?: unknown;
    readonly isError?: boolean;
  };
}) {
  const toolInfo = deps.session.currentToolInfoById.get(deps.message.toolCallId);
  deps.session.currentToolInfoById.delete(deps.message.toolCallId);
  deps.session.currentToolOutputById.delete(deps.message.toolCallId);
  const detail = normalizeString(
    typeof deps.message.result === "string"
      ? deps.message.result
      : JSON.stringify(deps.message.result),
  );
  yield* emitWithTurnAppend({
    emit: deps.emit,
    session: deps.session,
    events: [
      {
        ...eventBase({
          eventId: deps.stamp.eventId,
          createdAt: deps.stamp.createdAt,
          threadId: deps.session.threadId,
          ...(deps.session.activeTurnId ? { turnId: deps.session.activeTurnId } : {}),
          itemId: deps.message.toolCallId,
          raw: deps.raw,
        }),
        type: "item.completed",
        payload: {
          itemType: toolInfo?.itemType ?? "dynamic_tool_call",
          status: deps.message.isError ? "failed" : "completed",
          title: toolInfo?.title ?? titleForTool("dynamic_tool_call"),
          ...(detail ? { detail } : {}),
          ...(deps.message.result !== undefined ? { data: deps.message.result } : {}),
        },
      },
    ],
  });
});

export const handleTurnEnd = Effect.fn("handleTurnEnd")(function* (deps: {
  readonly emit: PiEmitEvents;
  readonly session: ActivePiSession;
  readonly stamp: { eventId: EventId; createdAt: string };
  readonly raw: NonNullable<ProviderRuntimeEvent["raw"]>;
  readonly message: {
    readonly message?: Record<string, unknown>;
  };
}) {
  const turnId = deps.session.activeTurnId;
  if (!turnId) {
    return;
  }

  const messageRecord = isRecord(deps.message.message) ? deps.message.message : undefined;
  const stopReason = normalizeString(messageRecord?.stopReason);
  const errorMessage = normalizeString(messageRecord?.errorMessage);
  if (errorMessage) {
    deps.session.lastError = errorMessage;
  }
  const usage = normalizeUsage(messageRecord?.usage);
  if (usage) {
    deps.session.lastUsage = usage;
  }

  deps.session.completedTurnBoundary = {
    stamp: deps.stamp,
    raw: deps.raw,
    message: deps.message,
  };

  const sessionStateChangedEvent = {
    ...eventBase({
      eventId: EventId.makeUnsafe(randomUUID()),
      createdAt: deps.stamp.createdAt,
      threadId: deps.session.threadId,
      raw: deps.raw,
    }),
    type: "session.state.changed" as const,
    payload: {
      state: deps.session.agentRunning ? "running" : "ready",
      reason: deps.session.agentRunning ? "turn.completed.awaiting_agent_end" : "turn.completed",
    },
  } satisfies ProviderRuntimeEvent;

  if (deps.session.agentRunning) {
    yield* emitWithTurnAppend({
      emit: deps.emit,
      session: deps.session,
      events: [sessionStateChangedEvent],
    });
    return;
  }

  yield* emitWithTurnAppend({
    emit: deps.emit,
    session: deps.session,
    events: [
      {
        ...eventBase({
          eventId: deps.stamp.eventId,
          createdAt: deps.stamp.createdAt,
          threadId: deps.session.threadId,
          turnId,
          raw: deps.raw,
        }),
        type: "turn.completed",
        payload: {
          state:
            stopReason === "aborted"
              ? "interrupted"
              : stopReason === "error"
                ? "failed"
                : "completed",
          ...(stopReason ? { stopReason } : {}),
          ...(messageRecord?.usage !== undefined ? { usage: messageRecord.usage } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
      sessionStateChangedEvent,
    ],
  });
});
