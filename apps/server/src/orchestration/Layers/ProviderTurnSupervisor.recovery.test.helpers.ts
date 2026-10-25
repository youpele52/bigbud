import {
  MessageId,
  type OrchestrationCommand,
  OrchestrationThread,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { Effect, Layer, Option, Schema, Stream } from "effect";

import { ProviderDispatchAttemptRepositoryLive } from "../../persistence/Layers/ProviderDispatchAttempts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRecoveryIntentRepositoryLive } from "../../persistence/Layers/ThreadRecoveryIntents.ts";
import { ProviderDispatchAttemptRepository } from "../../persistence/Services/ProviderDispatchAttempts.ts";
import { ThreadRecoveryIntentRepository } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { SystemSleepEpochsLive } from "../../system-sleep/Layers/SystemSleepEpochs.ts";
import { SystemSleepEpochs } from "../../system-sleep/Services/SystemSleepEpochs.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type { InspectionOutcome } from "./ProviderTurnSupervisor.policy.logic.ts";
import { makeRecoveryMemory, type RecoveryContext } from "./ProviderTurnSupervisor.state.ts";

/** Wall time the machine woke in every scenario. */
export const WOKE_AT_MS = Date.parse("2026-10-22T10:10:00.000Z");
export const SLEPT_AT_MS = WOKE_AT_MS - 10 * 60_000;
export const threadId = ThreadId.makeUnsafe("recovering-thread");
export const messageId = MessageId.makeUnsafe("original-message");
export const turnId = TurnId.makeUnsafe("original-turn");

export const recoveryTestLayer = Layer.mergeAll(
  ThreadRecoveryIntentRepositoryLive,
  ProviderDispatchAttemptRepositoryLive,
  Layer.fresh(SystemSleepEpochsLive),
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

function baseThread(): OrchestrationThread {
  return Schema.decodeUnknownSync(OrchestrationThread)({
    id: threadId,
    projectId: "project",
    title: "Recovering",
    modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: new Date(SLEPT_AT_MS - 60_000).toISOString(),
    updatedAt: new Date(SLEPT_AT_MS).toISOString(),
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId,
      status: "running",
      providerName: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: new Date(SLEPT_AT_MS).toISOString(),
    },
  });
}

export interface RecoveryHarnessOptions {
  readonly continuationEnabled?: boolean;
  readonly rejectTurnStart?: boolean;
  readonly inspection?: InspectionOutcome;
  /** Replaces the provider inspection; runs where the coordinator would release its permit. */
  readonly inspect?: () => Effect.Effect<InspectionOutcome>;
  /** The thread is outside the startup window: absent until `ensureThreadState` loads it. */
  readonly loadOnDemand?: boolean;
  /** The provider runtime stream the live coordinator subscribes to. */
  readonly runtimeEvents?: Stream.Stream<ProviderRuntimeEvent>;
  /** Replaces provider calls, for example a stop that never answers. */
  readonly provider?: Partial<Pick<ProviderServiceShape, "interruptTurn" | "stopSession">>;
}

export const makeRecoveryHarness = Effect.fn("makeRecoveryHarness")(function* (
  options: RecoveryHarnessOptions = {},
) {
  let thread = baseThread();
  let loaded = options.loadOnDemand !== true;
  let now = WOKE_AT_MS + 1_000;
  const commands: OrchestrationCommand[] = [];
  /** Runs inside a `thread.turn.start` dispatch; returning false makes the engine refuse it. */
  let turnStartInterceptor: (() => Effect.Effect<boolean>) | null = null;
  /** How many of the next `thread.recovery.set` dispatches fail. */
  let failingRecoverySets = 0;
  const intents = yield* ThreadRecoveryIntentRepository;
  const attempts = yield* ProviderDispatchAttemptRepository;
  const sleep = yield* SystemSleepEpochs;
  const engine = {
    getReadModel: () =>
      Effect.sync(() => ({
        snapshotSequence: commands.length,
        projects: [],
        threads: loaded ? [thread] : [],
        updatedAt: new Date(now).toISOString(),
      })),
    ...(options.loadOnDemand
      ? {
          ensureThreadState: () =>
            Effect.sync(() => {
              loaded = true;
              return thread;
            }),
        }
      : {}),
    dispatch: (command: OrchestrationCommand) =>
      Effect.suspend(() => {
        if (command.type === "thread.recovery.set" && failingRecoverySets > 0) {
          failingRecoverySets -= 1;
          return Effect.fail(new Error("recovery set failed"));
        }
        commands.push(command);
        if (command.type === "thread.recovery.set") {
          thread = { ...thread, recovery: command.recovery };
        }
        if (command.type === "thread.turn.start" && options.rejectTurnStart) {
          return Effect.fail(new Error("rejected"));
        }
        if (command.type === "thread.turn.start" && turnStartInterceptor !== null) {
          return turnStartInterceptor().pipe(
            Effect.flatMap((accepted) =>
              accepted
                ? Effect.succeed({ sequence: commands.length })
                : Effect.fail(new Error("refused")),
            ),
          );
        }
        return Effect.succeed({ sequence: commands.length });
      }),
    streamDomainEvents: Stream.empty,
  } as unknown as OrchestrationEngineShape;
  const providerService = {
    inspectActiveTurn: () =>
      (options.inspect?.() ?? Effect.succeed(options.inspection ?? "unavailable")).pipe(
        Effect.map((status) => ({ status, observedAt: new Date(now).toISOString() })),
      ),
    listActiveTurnLiveness: () => Effect.succeed([]),
    interruptTurn: () => Effect.void,
    stopSession: () => Effect.void,
    streamEvents: options.runtimeEvents ?? Stream.empty,
    ...options.provider,
  } as unknown as ProviderServiceShape;
  const ctx: RecoveryContext = {
    engine,
    providerService,
    intents,
    attempts: Option.some(attempts),
    sleep: Option.some(sleep),
    continuationEnabled: options.continuationEnabled ?? true,
    nowMs: () => now,
    memory: makeRecoveryMemory(),
    outsidePermit: (effect) => effect,
  };

  /** An accepted, dispatched and acknowledged turn that was running when the lid closed. */
  const seedRunningTurn = Effect.gen(function* () {
    const createdAt = new Date(SLEPT_AT_MS - 30_000).toISOString();
    yield* intents.recordAccepted({ threadId, messageId, provider: "claudeAgent", createdAt });
    const attempt = yield* attempts.markMayHaveBeenSent({
      threadId,
      messageId,
      provider: "claudeAgent",
      payloadDigest: "digest",
      at: createdAt,
    });
    yield* attempts.acknowledgeWith(
      {
        attemptId: Option.getOrThrow(attempt).attemptId,
        threadId,
        messageId,
        turnId,
        provider: "claudeAgent",
        at: createdAt,
      },
      Effect.void,
    );
  });

  return {
    ctx,
    intents,
    attempts,
    sleep,
    commands,
    seedRunningTurn,
    /** The machine slept for ten minutes and woke at `WOKE_AT_MS`. */
    sleepAndWake: sleep.recordEvidence({
      source: "server-gap",
      startedAtMs: SLEPT_AT_MS,
      endedAtMs: WOKE_AT_MS,
    }),
    advance: (ms: number) => {
      now += ms;
    },
    nowMs: () => now,
    thread: () => thread,
    /** Whether the thread is in the in-memory read model. */
    loaded: () => loaded,
    patchThread: (patch: Partial<OrchestrationThread>) => {
      thread = { ...thread, ...patch };
    },
    setTurnStartInterceptor: (interceptor: () => Effect.Effect<boolean>) => {
      turnStartInterceptor = interceptor;
    },
    failNextRecoverySets: (count: number) => {
      failingRecoverySets = count;
    },
    /** The thread is idle: its session is ready with no turn. */
    idleThread: () => {
      thread = {
        ...thread,
        session: { ...thread.session!, status: "ready", activeTurnId: null },
      };
    },
    /** The turn ended in error: the session is no longer running a turn. */
    endTurnWithError: () => {
      thread = {
        ...thread,
        session: { ...thread.session!, status: "error", activeTurnId: null },
      };
    },
    intent: () =>
      intents.get({ threadId, messageId }).pipe(Effect.map((found) => Option.getOrThrow(found))),
    turnStarts: () => commands.filter((command) => command.type === "thread.turn.start"),
  };
});

export type RecoveryHarness = Effect.Success<ReturnType<typeof makeRecoveryHarness>>;

export const failureAt = (atMs: number, detail = "socket hang up") => ({
  threadId,
  turnId,
  kind: "runtime-error" as const,
  observedAtMs: atMs,
  detail,
});
