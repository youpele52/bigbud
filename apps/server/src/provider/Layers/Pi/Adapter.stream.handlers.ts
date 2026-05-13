import { randomUUID } from "node:crypto";

import {
  EventId,
  ThreadId,
  type ProviderRuntimeEvent,
  type UserInputQuestion,
} from "@bigbud/contracts";
import { FULL_ACCESS_AUTO_APPROVE_AFTER_MS } from "@bigbud/shared/approvals";
import { Effect } from "effect";

import { ProviderAdapterRequestError } from "../../Errors.ts";
import type {
  ActivePiSession,
  PiEmitEvents,
  PiRunPromise,
  PiSyntheticEventFn,
} from "./Adapter.types.ts";
import { PROVIDER, USER_INPUT_FALLBACK_QUESTION_ID } from "./Adapter.types.ts";
import type { PiRpcExtensionUIRequest } from "./RpcProcess.ts";
import {
  classifyToolItemType,
  eventBase,
  isRecord,
  normalizeString,
  normalizeUsage,
  titleForTool,
  toMessage,
} from "./Adapter.utils.ts";

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

function buildQuestion(message: PiRpcExtensionUIRequest): UserInputQuestion | undefined {
  switch (message.method) {
    case "select": {
      const title = normalizeString(message.title) ?? "Selection";
      const options = message.options
        .map((entry) => normalizeString(entry))
        .filter((entry): entry is string => entry !== undefined)
        .map((entry) => ({ label: entry, description: entry }));
      return {
        id: USER_INPUT_FALLBACK_QUESTION_ID,
        header: title,
        question: title,
        options,
      };
    }
    case "confirm": {
      const title = normalizeString(message.title) ?? "Confirmation";
      const body = normalizeString(message.message);
      return {
        id: USER_INPUT_FALLBACK_QUESTION_ID,
        header: title,
        question: body ?? title,
        options: [
          { label: "Yes", description: "Yes" },
          { label: "No", description: "No" },
        ],
      };
    }
    case "input": {
      const title = normalizeString(message.title) ?? "Input";
      const placeholder = normalizeString(message.placeholder);
      return {
        id: USER_INPUT_FALLBACK_QUESTION_ID,
        header: title,
        question: placeholder ?? title,
        options: [],
      };
    }
    case "editor": {
      const title = normalizeString(message.title) ?? "Editor";
      return {
        id: USER_INPUT_FALLBACK_QUESTION_ID,
        header: title,
        question: title,
        options: [],
      };
    }
    default:
      return undefined;
  }
}

function autoResolveConfirm(deps: {
  readonly session: ActivePiSession;
  readonly requestId: string;
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly runPromise: PiRunPromise;
  readonly sessions: Map<ThreadId, ActivePiSession>;
}) {
  return Effect.gen(function* () {
    yield* Effect.sleep(FULL_ACCESS_AUTO_APPROVE_AFTER_MS);
    const pending = deps.session.pendingUserInputs.get(deps.requestId);
    if (!pending || pending.responding || !deps.sessions.has(deps.session.threadId)) {
      return;
    }
    pending.responding = true;
    yield* Effect.tryPromise({
      try: () =>
        deps.session.process.write({
          type: "extension_ui_response",
          id: deps.requestId,
          confirmed: true,
        }),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: toMessage(cause, "Failed to auto-respond to Pi confirm request."),
          cause,
        }),
    }).pipe(Effect.orElseSucceed(() => undefined));

    if (!deps.session.pendingUserInputs.has(deps.requestId)) {
      return;
    }
    deps.session.pendingUserInputs.delete(deps.requestId);
    yield* deps.emit([
      yield* deps.makeSyntheticEvent(
        deps.session.threadId,
        "user-input.resolved",
        { answers: { [pending.question.id]: "Yes" } },
        {
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId: deps.requestId,
        },
      ),
      yield* deps.makeSyntheticEvent(deps.session.threadId, "session.state.changed", {
        state: deps.session.activeTurnId ? "running" : "ready",
        reason: "user-input.resolved",
      }),
    ]);
  })
    .pipe(deps.runPromise)
    .catch(() => undefined);
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

export const handleToolExecutionUpdate = Effect.fn("handleToolExecutionUpdate")(function* (deps: {
  readonly emit: PiEmitEvents;
  readonly session: ActivePiSession;
  readonly stamp: { eventId: EventId; createdAt: string };
  readonly raw: NonNullable<ProviderRuntimeEvent["raw"]>;
  readonly message: {
    readonly toolCallId: string;
    readonly partialResult?: string;
  };
}) {
  const partialResult = normalizeString(deps.message.partialResult);
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

  deps.session.activeTurnId = undefined;
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
      {
        ...eventBase({
          eventId: EventId.makeUnsafe(randomUUID()),
          createdAt: deps.stamp.createdAt,
          threadId: deps.session.threadId,
          raw: deps.raw,
        }),
        type: "session.state.changed",
        payload: {
          state: "ready",
          reason: "turn.completed",
        },
      },
    ],
  });
});

export const handleExtensionUiRequest = Effect.fn("handleExtensionUiRequest")(function* (deps: {
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly runPromise: PiRunPromise;
  readonly session: ActivePiSession;
  readonly sessions: Map<ThreadId, ActivePiSession>;
  readonly message: PiRpcExtensionUIRequest;
}) {
  if (
    deps.message.method === "notify" ||
    deps.message.method === "setStatus" ||
    deps.message.method === "setWidget" ||
    deps.message.method === "setTitle" ||
    deps.message.method === "set_editor_text"
  ) {
    return;
  }

  const question = buildQuestion(deps.message);
  if (!question) {
    return;
  }

  deps.session.pendingUserInputs.set(deps.message.id, {
    requestId: deps.message.id,
    turnId: deps.session.activeTurnId,
    question,
    responding: false,
  });

  const opened = yield* deps.makeSyntheticEvent(
    deps.session.threadId,
    "user-input.requested",
    { questions: [question] },
    {
      ...(deps.session.activeTurnId ? { turnId: deps.session.activeTurnId } : {}),
      requestId: deps.message.id,
    },
  );
  const waiting = yield* deps.makeSyntheticEvent(deps.session.threadId, "session.state.changed", {
    state: "waiting",
    reason: "user-input.requested",
  });
  yield* emitWithTurnAppend({ emit: deps.emit, session: deps.session, events: [opened, waiting] });

  if (deps.session.runtimeMode === "full-access" && deps.message.method === "confirm") {
    void autoResolveConfirm({
      session: deps.session,
      requestId: deps.message.id,
      emit: deps.emit,
      makeSyntheticEvent: deps.makeSyntheticEvent,
      runPromise: deps.runPromise,
      sessions: deps.sessions,
    });
  }
});
