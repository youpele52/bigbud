/**
 * CopilotAdapter thin shell — stateful factory and Effect Layer.
 *
 * All types, interfaces, constants, and pure helpers live in
 * `CopilotAdapter.types.ts`. Session event mapping is in
 * `CopilotAdapter.mapEvent.ts`. Session lifecycle operations are in
 * `CopilotAdapter.session.ts`. This file contains only the stateful
 * `makeCopilotAdapter` factory and the exported Layer bindings.
 *
 * @module CopilotAdapter
 */
import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { type SessionEvent } from "@github/copilot-sdk";
import { Effect, Layer, Queue, Random, Stream } from "effect";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { makeEventNdjsonLogger } from "../EventNdjsonLogger.ts";
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../../Errors.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../../Services/Copilot/Adapter.ts";
import { buildSessionConfig } from "./Adapter.session.config.ts";
import {
  PROVIDER,
  USER_INPUT_QUESTION_ID,
  type ActiveCopilotSession,
  type CopilotAdapterLiveOptions,
  approvalDecisionToPermissionResult,
  eventBase,
  normalizeUsage,
} from "./Adapter.types.ts";
import { mapEvent, type MapEventDeps } from "./Adapter.mapEvent.ts";
import {
  type SessionOpsDeps,
  makeStartSession,
  makeSendTurn,
  makeInterruptTurn,
  makeStopSession,
  makeStopAll,
  makeListSessions,
  makeHasSession,
  makeReadThread,
  makeRollbackThread,
} from "./Adapter.session.ts";

export { makeNodeWrapperCliPath } from "./Adapter.types.ts";
export type { CopilotAdapterLiveOptions } from "./Adapter.types.ts";

const makeCopilotAdapter = Effect.fn("makeCopilotAdapter")(function* (
  options?: CopilotAdapterLiveOptions,
) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const sessions = new Map<ThreadId, ActiveCopilotSession>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
  const makeEventStamp = () =>
    Effect.all({
      eventId: nextEventId,
      createdAt: Effect.sync(() => new Date().toISOString()),
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ActiveCopilotSession, ProviderAdapterSessionNotFoundError> => {
    const session = sessions.get(threadId);
    return session
      ? Effect.succeed(session)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const emit = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid);

  const logNativeEvent = Effect.fn("logNativeEvent")(function* (
    threadId: ThreadId,
    event: SessionEvent,
  ) {
    if (!nativeEventLogger) {
      return;
    }

    yield* nativeEventLogger.write(
      {
        observedAt: new Date().toISOString(),
        event,
      },
      threadId,
    );
  });

  const makeSyntheticEvent = <TType extends ProviderRuntimeEvent["type"]>(
    threadId: ThreadId,
    type: TType,
    payload: Extract<ProviderRuntimeEvent, { type: TType }>["payload"],
    extra?: { turnId?: TurnId; itemId?: string; requestId?: string },
  ): Effect.Effect<Extract<ProviderRuntimeEvent, { type: TType }>> =>
    Effect.gen(function* () {
      const stamp = yield* makeEventStamp();
      return {
        ...eventBase({
          eventId: stamp.eventId,
          createdAt: stamp.createdAt,
          threadId,
          ...(extra?.turnId ? { turnId: extra.turnId } : {}),
          ...(extra?.itemId ? { itemId: extra.itemId } : {}),
          ...(extra?.requestId ? { requestId: extra.requestId } : {}),
          raw: {
            source: "copilot.sdk.synthetic",
            payload,
          },
        }),
        type,
        payload,
      } as Extract<ProviderRuntimeEvent, { type: TType }>;
    });

  const mapEventDeps: MapEventDeps = { makeEventStamp, nextEventId, emit };

  const handleEvent = Effect.fn("handleEvent")(function* (
    session: ActiveCopilotSession,
    event: SessionEvent,
  ) {
    session.updatedAt = event.timestamp;

    if (event.type === "assistant.turn_start") {
      const turnId = TurnId.makeUnsafe(event.data.turnId);
      session.activeTurnId = turnId;
      session.turns.push({ id: turnId, items: [event] });
    } else if (event.type === "assistant.message") {
      session.activeMessageId = event.data.messageId;
      session.turns.at(-1)?.items.push(event);
    } else if (
      event.type === "assistant.message_delta" ||
      event.type === "assistant.reasoning_delta" ||
      event.type === "assistant.reasoning" ||
      event.type === "assistant.usage" ||
      event.type === "tool.execution_start" ||
      event.type === "tool.execution_complete" ||
      event.type === "user_input.requested" ||
      event.type === "user_input.completed"
    ) {
      session.turns.at(-1)?.items.push(event);
    } else if (
      event.type === "session.idle" ||
      event.type === "abort" ||
      event.type === "assistant.turn_end" ||
      event.type === "session.error"
    ) {
      session.turns.at(-1)?.items.push(event);
    }

    if (event.type === "assistant.usage") {
      session.lastUsage = normalizeUsage(event);
    }

    if (event.type === "session.error") {
      session.lastError = event.data.message;
    }

    yield* logNativeEvent(session.threadId, event);
    const mapped = yield* mapEvent(mapEventDeps, session, event);
    if (mapped.length > 0) {
      yield* emit(mapped);
    }

    // Clear active turn/message AFTER mapEvent so that turn.completed and
    // turn.aborted events are emitted with the correct turnId.
    if (event.type === "session.idle" || event.type === "abort") {
      session.activeTurnId = undefined;
      session.activeMessageId = undefined;
    }
  });

  const sessionDeps: SessionOpsDeps = {
    sessions,
    serverConfig: { attachmentsDir: serverConfig.attachmentsDir },
    serverSettings,
    options,
    emit,
    // Cast: the generic overload is compatible at runtime; TS can't verify generic → non-generic assignment.
    // biome-ignore lint/suspicious/noExplicitAny: generic→non-generic function covariance
    makeSyntheticEvent: makeSyntheticEvent as any,
    buildSessionConfig: (input, pendingApprovals, pendingUserInputs, activeTurnId, stoppedRef) =>
      buildSessionConfig({
        ...input,
        pendingApprovals,
        pendingUserInputs,
        activeTurnId,
        stoppedRef,
        emit,
        makeSyntheticEvent: makeSyntheticEvent as SessionOpsDeps["makeSyntheticEvent"],
      }),
    handleEvent,
    requireSession,
  };

  const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      const pending = record.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.permission.respond",
          detail: `Unknown pending GitHub Copilot approval request '${requestId}'.`,
        });
      }

      record.pendingApprovals.delete(requestId);
      pending.resolve(approvalDecisionToPermissionResult(decision, pending.request));
      const event = yield* makeSyntheticEvent(
        threadId,
        "request.resolved",
        {
          requestType: pending.requestType,
          decision,
        },
        {
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId,
        },
      );
      yield* emit([event]);
    });

  const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      const pending = record.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.userInput.respond",
          detail: `Unknown pending GitHub Copilot user-input request '${requestId}'.`,
        });
      }

      record.pendingUserInputs.delete(requestId);
      const candidate =
        typeof answers[USER_INPUT_QUESTION_ID] === "string"
          ? answers[USER_INPUT_QUESTION_ID]
          : (Object.values(answers).find((value): value is string => typeof value === "string") ??
            "");
      pending.resolve({
        answer: candidate,
        wasFreeform: !pending.choices.includes(candidate),
      });

      const event = yield* makeSyntheticEvent(
        threadId,
        "user-input.resolved",
        { answers },
        {
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId,
        },
      );
      yield* emit([event]);
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "restart-session",
    },
    startSession: makeStartSession(sessionDeps),
    sendTurn: makeSendTurn(sessionDeps),
    interruptTurn: makeInterruptTurn(sessionDeps),
    respondToRequest,
    respondToUserInput,
    stopSession: makeStopSession(sessionDeps),
    listSessions: makeListSessions(sessionDeps),
    hasSession: makeHasSession(sessionDeps),
    readThread: makeReadThread(sessionDeps),
    rollbackThread: makeRollbackThread(),
    stopAll: makeStopAll(sessionDeps),
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies CopilotAdapterShape;
});

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());

export function makeCopilotAdapterLive(options?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(options));
}
