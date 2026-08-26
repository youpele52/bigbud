/**
 * ProviderRuntimeIngestion — thin shell Layer wiring.
 *
 * Sets up caches and wires the `ProviderRuntimeIngestionLive` Effect Layer.
 * Per-event processing is delegated to `makeRuntimeEventProcessor` from
 * `ProviderRuntimeIngestion.processor.ts`.
 *
 * @module ProviderRuntimeIngestion
 */
import { Clock, Effect, Layer, Schedule, Scope, Stream } from "effect";
import { Cause } from "effect";
import { type DrainableWorker, makeDrainableWorker } from "@bigbud/shared/DrainableWorker";
import { increment } from "../../observability/Metrics.ts";
import {
  providerReconciliationDiscoveryTotal,
  providerReconciliationPassesTotal,
} from "../../observability/Metrics.load.ts";

import {
  ProviderService,
  type ProviderSessionReconciliationOptions,
  type ProviderSessionDiscoveryResult,
} from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import {
  type RuntimeIngestionInput,
  type TurnStartRequestedDomainEvent,
} from "./ProviderRuntimeIngestion.helpers.ts";
import {
  makeRuntimeEventProcessor,
  type RuntimeProcessorServices,
} from "./ProviderRuntimeIngestion.processor.ts";
import { makeRuntimeProcessorCacheHelpers } from "./ProviderRuntimeIngestion.cache.ts";
import {
  buildStartupReconciliationCommands,
  buildThreadReconciliationCommand,
  dispatchReconciliationCommandSafely,
} from "./ProviderRuntimeIngestion.reconcile.ts";
import {
  makePeriodicReconciliationState,
  markPeriodicReconciliationDirty,
  selectPeriodicReconciliationThreads,
} from "./ProviderRuntimeIngestion.periodic.ts";
import { superviseProviderTurns } from "./ProviderTurnSupervisor.ts";
import { recoverTurnControlOperations } from "./ProviderRuntimeIngestion.turnControlRecovery.ts";

const RECONCILIATION_RUNTIME_EVENT_TYPES = new Set([
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "runtime.error",
]);

const RECONCILIATION_DOMAIN_EVENT_TYPES = new Set([
  "thread.turn-start-requested",
  "thread.turn-start-failed",
  "thread.turn-interrupt-requested",
  "thread.turn-control-set",
  "thread.session-stop-requested",
  "thread.session-set",
]);

const make = Effect.fn("make")(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const cacheHelpers = yield* makeRuntimeProcessorCacheHelpers();

  const processorServices: RuntimeProcessorServices = {
    orchestrationEngine,
    providerService,
    serverSettingsService,
    projectionTurnRepository,
  };

  const processRuntimeEvent = makeRuntimeEventProcessor(processorServices, cacheHelpers);

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );
  const threadWorkers = new Map<string, DrainableWorker<RuntimeIngestionInput>>();
  const outerScope = yield* Effect.scope;
  let reconciliationPassRunning = false;
  const discoveryCacheTtlMs = 15_000;
  let discoveryCache: {
    readonly key: string;
    readonly expiresAt: number;
    readonly result: ProviderSessionDiscoveryResult;
  } | null = null;
  const periodicReconciliationState = makePeriodicReconciliationState();

  const discoverProviderSessions = Effect.fn("discoverProviderSessions")(function* (
    options: ProviderSessionReconciliationOptions = {},
  ) {
    const now = Date.now();
    const cursorKey =
      options.directoryMode === "audit"
        ? `${options.cursor?.lastSeenAt ?? ""}:${options.cursor?.threadId ?? ""}`
        : "";
    const key = `${options.directoryMode ?? "all"}:${options.limit ?? ""}:${options.includeAdapters ?? true}:${cursorKey}`;
    if (discoveryCache !== null && discoveryCache.key === key && discoveryCache.expiresAt > now) {
      yield* increment(providerReconciliationDiscoveryTotal, { outcome: "cache-hit" });
      return discoveryCache.result;
    }
    const discovery = yield* providerService.listSessionsForReconciliation(options);
    if (discovery.diagnostics.length === 0 && discovery.directoryAvailable) {
      discoveryCache = { key, expiresAt: now + discoveryCacheTtlMs, result: discovery };
    } else {
      discoveryCache = null;
    }
    yield* increment(providerReconciliationDiscoveryTotal, { outcome: "refresh" });
    if (discovery.diagnostics.length > 0) {
      yield* Effect.logWarning(
        "provider runtime reconciliation discovery was partially unavailable",
        {
          diagnostics: discovery.diagnostics,
        },
      );
    }
    return discovery;
  });

  const getOrCreateThreadWorker = (threadId: string) => {
    const existing = threadWorkers.get(threadId);
    if (existing !== undefined) {
      return Effect.succeed(existing);
    }
    return makeDrainableWorker(processInputSafely).pipe(
      Effect.provideService(Scope.Scope, outerScope),
      Effect.tap((worker) => Effect.sync(() => threadWorkers.set(threadId, worker))),
    );
  };

  const superviseActiveTurns = () =>
    superviseProviderTurns({
      orchestrationEngine,
      providerService,
    });

  const reconcileThreadSessionsAtStartup = Effect.fn("reconcileThreadSessionsAtStartup")(
    function* () {
      const [readModel, discovery] = yield* Effect.all([
        orchestrationEngine.getReadModel(),
        discoverProviderSessions(),
      ]);
      const liveSessions = discovery.sessions;
      const reconcilableThreads = readModel.threads.filter((thread) =>
        discovery.availableProviders.has(thread.modelSelection.provider),
      );
      const occurredAt = new Date().toISOString();
      const commands = buildStartupReconciliationCommands({
        threads: reconcilableThreads,
        liveSessions,
        occurredAt,
      });

      yield* Effect.forEach(
        commands,
        (command) => dispatchReconciliationCommandSafely(orchestrationEngine, command),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* recoverTurnControlOperations({
        orchestrationEngine,
        readModel: yield* orchestrationEngine.getReadModel(),
        liveSessions,
        occurredAt,
      });

      if (commands.length > 0) {
        yield* Effect.logInfo("provider runtime ingestion reconciled thread sessions at startup", {
          reconciledCount: commands.length,
          liveSessionCount: liveSessions.length,
        });
      }
    },
  );

  const reconcileActiveThreadSessions = Effect.fn("reconcileActiveThreadSessions")(function* () {
    if (reconciliationPassRunning) return;
    reconciliationPassRunning = true;
    yield* increment(providerReconciliationPassesTotal, { outcome: "started" });
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const observedAt = yield* Clock.currentTimeMillis;
        const [readModel, discovery] = yield* Effect.all([
          orchestrationEngine.getReadModel(),
          discoverProviderSessions({
            directoryMode: "hot",
            recentSince: new Date(observedAt - 15 * 60 * 1000).toISOString(),
            limit: 250,
          }),
        ]);
        if (observedAt - periodicReconciliationState.lastSafetyAuditAt >= 60_000) {
          const audit = yield* discoverProviderSessions({
            directoryMode: "audit",
            includeAdapters: false,
            cursor: periodicReconciliationState.auditCursor,
            limit: 250,
          });
          for (const threadId of audit.directoryThreadIds ?? []) {
            markPeriodicReconciliationDirty(periodicReconciliationState, threadId);
          }
          periodicReconciliationState.auditCursor = audit.directoryCursor ?? null;
          periodicReconciliationState.lastSafetyAuditAt = observedAt;
        }
        const sessionsByThreadId = new Map(
          discovery.sessions.map((session) => [session.threadId, session]),
        );
        const commands = selectPeriodicReconciliationThreads(
          readModel.threads,
          periodicReconciliationState,
          observedAt,
        ).flatMap((thread) => {
          if (!discovery.availableProviders.has(thread.modelSelection.provider)) return [];
          const liveSession = sessionsByThreadId.get(thread.id);
          if (liveSession !== undefined) {
            periodicReconciliationState.missingSessionObservedAt.delete(thread.id);
          } else if (thread.session !== null && thread.session !== undefined) {
            const firstMissingAt = periodicReconciliationState.missingSessionObservedAt.get(
              thread.id,
            );
            if (firstMissingAt === undefined) {
              periodicReconciliationState.missingSessionObservedAt.set(thread.id, observedAt);
              return [];
            }
            if (observedAt - firstMissingAt < 5_000) return [];
          }
          const command = buildThreadReconciliationCommand({
            thread,
            liveSession,
            occurredAt: new Date().toISOString(),
          });
          return command ? [command] : [];
        });
        yield* Effect.forEach(
          commands,
          (command) => dispatchReconciliationCommandSafely(orchestrationEngine, command),
          { concurrency: 4 },
        );
        yield* recoverTurnControlOperations({
          orchestrationEngine,
          readModel: yield* orchestrationEngine.getReadModel(),
          liveSessions: discovery.sessions,
          occurredAt: new Date().toISOString(),
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : increment(providerReconciliationPassesTotal, { outcome: "failed" }).pipe(
                Effect.andThen(
                  Effect.logWarning("provider runtime periodic reconciliation failed", {
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
        ),
        Effect.tap(() => increment(providerReconciliationPassesTotal, { outcome: "completed" })),
      ),
      Effect.sync(() => {
        reconciliationPassRunning = false;
      }),
    );
  });

  const start: ProviderRuntimeIngestionShape["start"] = Effect.fn("start")(function* () {
    yield* reconcileThreadSessionsAtStartup().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider runtime ingestion failed to reconcile thread sessions", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* superviseActiveTurns().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider runtime ingestion failed to supervise persisted turns", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (RECONCILIATION_RUNTIME_EVENT_TYPES.has(event.type)) {
          markPeriodicReconciliationDirty(periodicReconciliationState, event.threadId);
          discoveryCache = null;
        }
        return getOrCreateThreadWorker(event.threadId).pipe(
          Effect.flatMap((worker) => worker.enqueue({ source: "runtime", event })),
        );
      }),
    );
    yield* Effect.forkScoped(
      Effect.all([reconcileActiveThreadSessions(), superviseActiveTurns()], {
        concurrency: 2,
        discard: true,
      }).pipe(Effect.repeat(Schedule.fixed("5 seconds"))),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.aggregateKind !== "thread") {
          return Effect.void;
        }
        if (RECONCILIATION_DOMAIN_EVENT_TYPES.has(event.type)) {
          markPeriodicReconciliationDirty(periodicReconciliationState, String(event.aggregateId));
          discoveryCache = null;
        }
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return getOrCreateThreadWorker(event.payload.threadId).pipe(
          Effect.flatMap((worker) => worker.enqueue({ source: "domain", event })),
        );
      }),
    );
  });

  return {
    start,
    drain: Effect.suspend(() =>
      Effect.forEach(Array.from(threadWorkers.values()), (worker) => worker.drain, {
        concurrency: "unbounded",
      }),
    ).pipe(Effect.asVoid),
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make(),
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
