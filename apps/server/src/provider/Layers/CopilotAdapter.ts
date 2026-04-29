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
import {
  EventId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type UserInputQuestion,
} from "@bigbud/contracts";
import {
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import { Effect, Layer, Queue, Random, Stream } from "effect";
import { randomUUID } from "node:crypto";

import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { FULL_ACCESS_AUTO_APPROVE_AFTER_MS } from "@bigbud/shared/approvals";
import {
  PROVIDER,
  USER_INPUT_QUESTION_ID,
  type ActiveCopilotSession,
  type CopilotAdapterLiveOptions,
  type CopilotUserInputRequest,
  type CopilotUserInputResponse,
  type PendingApprovalRequest,
  type PendingUserInputRequest,
  approvalDecisionToPermissionResult,
  eventBase,
  isCopilotModelSelection,
  normalizeUsage,
  requestDetailFromPermissionRequest,
  requestTypeFromPermissionRequest,
} from "./CopilotAdapter.types.ts";
import { mapEvent, type MapEventDeps } from "./CopilotAdapter.mapEvent.ts";
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
} from "./CopilotAdapter.session.ts";

export { makeNodeWrapperCliPath } from "./CopilotAdapter.types.ts";
export type { CopilotAdapterLiveOptions } from "./CopilotAdapter.types.ts";

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
      if (event.type === "session.idle" || event.type === "abort") {
        session.activeTurnId = undefined;
        session.activeMessageId = undefined;
      }
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
  });

  const buildSessionConfig = (
    input: {
      threadId: ThreadId;
      runtimeMode: ProviderSession["runtimeMode"];
      cwd?: string;
      modelSelection?: ProviderSendTurnInput["modelSelection"] | ProviderSession["resumeCursor"];
    },
    pendingApprovals: Map<string, PendingApprovalRequest>,
    pendingUserInputs: Map<string, PendingUserInputRequest>,
    activeTurnId: () => TurnId | undefined,
    stoppedRef: { stopped: boolean },
  ): SessionConfig => ({
    ...(isCopilotModelSelection(input.modelSelection)
      ? {
          model: input.modelSelection.model,
          ...(input.modelSelection.options?.reasoningEffort
            ? { reasoningEffort: input.modelSelection.options.reasoningEffort }
            : {}),
        }
      : {}),
    ...(input.cwd ? { workingDirectory: input.cwd } : {}),
    streaming: true,
    systemMessage: {
      mode: "append",
      content:
        "You have access to a Chromium browser in this environment. " +
        "Use it when the task requires live web interaction, navigation, UI verification, login flows, repros, scraping, or screenshots. " +
        "Prefer codebase inspection first when the task is local-only. " +
        "Summarize what was verified, including URL and important observations. " +
        "Avoid unnecessary browser use when terminal or file tools are sufficient.",
    },
    onPermissionRequest: (request) => {
      return new Promise<PermissionRequestResult>((resolve) => {
        const requestId = randomUUID();
        const currentTurnId = activeTurnId();
        const requestType = requestTypeFromPermissionRequest(request);
        const requestDetail = requestDetailFromPermissionRequest(request);
        pendingApprovals.set(requestId, {
          request,
          requestType,
          turnId: currentTurnId,
          resolve,
        });

        void makeSyntheticEvent(
          input.threadId,
          "request.opened",
          {
            requestType,
            ...(requestDetail ? { detail: requestDetail } : {}),
            args: request,
            ...(input.runtimeMode === "full-access"
              ? { autoApproveAfterMs: FULL_ACCESS_AUTO_APPROVE_AFTER_MS }
              : {}),
          },
          {
            ...(currentTurnId ? { turnId: currentTurnId } : {}),
            requestId,
          },
        )
          .pipe(
            Effect.flatMap((event) => emit([event])),
            Effect.runPromise,
          )
          .catch(() => undefined);

        if (input.runtimeMode === "full-access") {
          void Effect.gen(function* () {
            yield* Effect.sleep(FULL_ACCESS_AUTO_APPROVE_AFTER_MS);
            if (stoppedRef.stopped) {
              return;
            }
            const pending = pendingApprovals.get(requestId);
            if (!pending) {
              return;
            }

            pendingApprovals.delete(requestId);
            pending.resolve({ kind: "approve-once" });

            const event = yield* makeSyntheticEvent(
              input.threadId,
              "request.resolved",
              {
                requestType,
                decision: "accept",
              },
              {
                ...(currentTurnId ? { turnId: currentTurnId } : {}),
                requestId,
              },
            );
            yield* emit([event]);
          })
            .pipe(Effect.runPromise)
            .catch(() => undefined);
        }
      });
    },
    onUserInputRequest: (request: CopilotUserInputRequest, _invocation) =>
      new Promise<CopilotUserInputResponse>((resolve) => {
        const requestId = randomUUID();
        const currentTurnId = activeTurnId();
        pendingUserInputs.set(requestId, {
          turnId: currentTurnId,
          choices: request.choices ?? [],
          resolve,
        });

        const question: UserInputQuestion = {
          id: USER_INPUT_QUESTION_ID,
          header: "Question",
          question: request.question,
          options: (request.choices ?? []).map((choice: string) => ({
            label: choice,
            description: choice,
          })),
        };

        void makeSyntheticEvent(
          input.threadId,
          "user-input.requested",
          { questions: [question] },
          {
            ...(currentTurnId ? { turnId: currentTurnId } : {}),
            requestId,
          },
        )
          .pipe(
            Effect.flatMap((event) => emit([event])),
            Effect.runPromise,
          )
          .catch(() => undefined);
      }),
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
    buildSessionConfig,
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
