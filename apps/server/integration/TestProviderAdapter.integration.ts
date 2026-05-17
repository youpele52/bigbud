import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeSessionId,
  ProviderTurnStartResult,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { Effect, Queue, Stream } from "effect";

import {
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../src/provider/Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadTurnSnapshot,
} from "../src/provider/Services/ProviderAdapter.ts";
import {
  normalizeFixtureEvent,
  type FixtureProviderRuntimeEvent,
  type LegacyProviderRuntimeEvent,
} from "./TestProviderAdapter.integration.fixtureEvents.ts";
import {
  missingSessionEffect,
  nowIso,
  sessionNotFound,
} from "./TestProviderAdapter.integration.session.ts";
import type {
  MakeTestProviderAdapterHarnessOptions,
  SessionState,
  TestProviderAdapterHarness,
  TestTurnResponse,
} from "./TestProviderAdapter.integration.types.ts";

export type {
  FixtureProviderRuntimeEvent,
  LegacyProviderRuntimeEvent,
} from "./TestProviderAdapter.integration.fixtureEvents.ts";
export type {
  TestProviderAdapterHarness,
  TestTurnResponse,
} from "./TestProviderAdapter.integration.types.ts";

export const makeTestProviderAdapterHarness = (options?: MakeTestProviderAdapterHarnessOptions) =>
  Effect.gen(function* () {
    const provider = options?.provider ?? "codex";
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    let sessionCount = 0;
    const sessions = new Map<ThreadId, SessionState>();
    const queuedResponsesForNextSession: TestTurnResponse[] = [];
    const interruptCallsBySession = new Map<ThreadId, Array<TurnId | undefined>>();
    const approvalResponsesBySession = new Map<
      ThreadId,
      Array<{
        readonly threadId: ThreadId;
        readonly requestId: ApprovalRequestId;
        readonly decision: ProviderApprovalDecision;
      }>
    >();

    const emit = (event: ProviderRuntimeEvent) => Queue.offer(runtimeEvents, event);

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== provider) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: `Expected provider '${provider}' but received '${input.provider}'.`,
          });
        }

        sessionCount += 1;
        const threadId = input.threadId;
        const createdAt = nowIso();

        const session: ProviderSession = {
          provider,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId,
          cwd: input.cwd,
          resumeCursor: input.resumeCursor ?? { threadId: String(threadId), seed: sessionCount },
          createdAt,
          updatedAt: createdAt,
        };

        sessions.set(threadId, {
          session,
          snapshot: {
            threadId,
            turns: [],
          },
          turnCount: 0,
          queuedResponses: queuedResponsesForNextSession.splice(0),
          rollbackCalls: [],
        });

        return session;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const state = sessions.get(input.threadId);
        if (!state) {
          return yield* missingSessionEffect(provider, input.threadId);
        }

        state.turnCount += 1;
        const turnCount = state.turnCount;
        const turnId = TurnId.makeUnsafe(`turn-${turnCount}`);

        const response = state.queuedResponses.shift();
        if (!response) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `No queued turn response for thread ${input.threadId}.`,
          });
        }

        const assistantDeltas: string[] = [];
        const deferredTurnCompletedEvents: ProviderRuntimeEvent[] = [];
        for (const fixtureEvent of response.events) {
          const rawEvent: Record<string, unknown> = {
            ...(fixtureEvent as Record<string, unknown>),
            eventId: randomUUID(),
            provider,
            sessionId: RuntimeSessionId.makeUnsafe(String(input.threadId)),
            createdAt: nowIso(),
          };
          rawEvent.threadId = state.snapshot.threadId;
          if (Object.hasOwn(rawEvent, "turnId")) {
            rawEvent.turnId = turnId;
          }

          const runtimeEvent = normalizeFixtureEvent(rawEvent);
          const runtimeType = (runtimeEvent as { type: string }).type;
          if (runtimeType === "content.delta") {
            const payload = runtimeEvent.payload as { delta?: unknown } | undefined;
            if (typeof payload?.delta === "string") {
              assistantDeltas.push(payload.delta);
            }
          } else if (runtimeType === "message.delta") {
            const legacyDelta = (runtimeEvent as { delta?: unknown }).delta;
            if (typeof legacyDelta === "string") {
              assistantDeltas.push(legacyDelta);
            }
          }
          if (runtimeEvent.type === "turn.completed") {
            deferredTurnCompletedEvents.push(runtimeEvent);
            continue;
          }

          yield* emit(runtimeEvent);
        }

        if (response.mutateWorkspace && state.session.cwd) {
          yield* response.mutateWorkspace({ cwd: state.session.cwd!, turnCount });
        }

        const userItem = {
          type: "userMessage",
          content: [{ type: "text", text: input.input }],
        } as const;
        const assistantText = assistantDeltas.join("");
        const nextItems: Array<unknown> =
          assistantText.length > 0
            ? [userItem, { type: "agentMessage", text: assistantText }]
            : [userItem];

        const nextTurn: ProviderThreadTurnSnapshot = {
          id: turnId,
          items: nextItems,
        };

        state.snapshot = {
          threadId: state.snapshot.threadId,
          turns: [...state.snapshot.turns, nextTurn],
        };

        if (deferredTurnCompletedEvents.length === 0) {
          yield* emit({
            type: "turn.completed",
            eventId: EventId.makeUnsafe(randomUUID()),
            provider,
            createdAt: nowIso(),
            threadId: state.snapshot.threadId,
            turnId,
            payload: {
              state: "completed",
            },
          });
        } else {
          for (const completedEvent of deferredTurnCompletedEvents) {
            yield* emit(completedEvent);
          }
        }

        return {
          threadId: state.snapshot.threadId,
          turnId,
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      sessions.has(threadId)
        ? Effect.sync(() => {
            const existing = interruptCallsBySession.get(threadId) ?? [];
            existing.push(turnId);
            interruptCallsBySession.set(threadId, existing);
          })
        : missingSessionEffect(provider, threadId);

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      sessions.has(threadId)
        ? Effect.sync(() => {
            const existing = approvalResponsesBySession.get(threadId) ?? [];
            existing.push({
              threadId,
              requestId,
              decision,
            });
            approvalResponsesBySession.set(threadId, existing);
          })
        : missingSessionEffect(provider, threadId);

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      _requestId,
      _answers,
    ) => (sessions.has(threadId) ? Effect.void : missingSessionEffect(provider, threadId));

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.sync(() => {
        sessions.delete(threadId);
      });

    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (state) => state.session));

    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.succeed(sessions.has(threadId));

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) => {
      const state = sessions.get(threadId);
      if (!state) {
        return missingSessionEffect(provider, threadId);
      }
      return Effect.succeed(state.snapshot);
    };

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) => {
      const state = sessions.get(threadId);
      if (!state) {
        return missingSessionEffect(provider, threadId);
      }
      if (!Number.isInteger(numTurns) || numTurns < 0 || numTurns > state.snapshot.turns.length) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider,
            operation: "rollbackThread",
            issue: "numTurns must be an integer between 0 and current turn count.",
          }),
        );
      }

      return Effect.sync(() => {
        state.rollbackCalls.push(numTurns);
        state.snapshot = {
          threadId: state.snapshot.threadId,
          turns: state.snapshot.turns.slice(0, state.snapshot.turns.length - numTurns),
        };
        state.turnCount = state.snapshot.turns.length;
        return state.snapshot;
      });
    };

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.sync(() => {
        sessions.clear();
      });

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEvents),
    };

    const queueTurnResponse = (
      threadId: ThreadId,
      response: TestTurnResponse,
    ): ReturnType<TestProviderAdapterHarness["queueTurnResponse"]> =>
      Effect.sync(() => sessions.get(threadId)).pipe(
        Effect.flatMap((state) =>
          state
            ? Effect.sync(() => {
                state.queuedResponses.push(response);
              })
            : Effect.fail(sessionNotFound(provider, threadId)),
        ),
      );

    const queueTurnResponseForNextSession = (
      response: TestTurnResponse,
    ): Effect.Effect<void, never> =>
      Effect.sync(() => {
        queuedResponsesForNextSession.push(response);
      });

    const getRollbackCalls = (threadId: ThreadId): ReadonlyArray<number> => {
      const state = sessions.get(threadId);
      if (!state) {
        return [];
      }
      return [...state.rollbackCalls];
    };

    const getStartCount = (): number => sessionCount;

    const getInterruptCalls = (threadId: ThreadId): ReadonlyArray<TurnId | undefined> => {
      const calls = interruptCallsBySession.get(threadId);
      if (!calls) {
        return [];
      }
      return [...calls];
    };

    const listActiveSessionIds = (): ReadonlyArray<ThreadId> =>
      Array.from(sessions.values(), (state) => state.session.threadId);

    const getApprovalResponses = (
      threadId: ThreadId,
    ): ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly requestId: ApprovalRequestId;
      readonly decision: ProviderApprovalDecision;
    }> => {
      const responses = approvalResponsesBySession.get(threadId);
      if (!responses) {
        return [];
      }
      return [...responses];
    };

    return {
      adapter,
      provider,
      queueTurnResponse,
      queueTurnResponseForNextSession,
      getStartCount,
      getRollbackCalls,
      getInterruptCalls,
      listActiveSessionIds,
      getApprovalResponses,
    } satisfies TestProviderAdapterHarness;
  });
