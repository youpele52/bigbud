/**
 * ProviderRuntimeIngestion — thin shell Layer wiring.
 *
 * Sets up caches and wires the `ProviderRuntimeIngestionLive` Effect Layer.
 * Per-event processing is delegated to `makeRuntimeEventProcessor` from
 * `ProviderRuntimeIngestion.processor.ts`.
 *
 * @module ProviderRuntimeIngestion
 */
import { Effect, Layer, Scope, Stream } from "effect";
import { Cause } from "effect";
import { type DrainableWorker, makeDrainableWorker } from "@bigbud/shared/DrainableWorker";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
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
import { buildStartupReconciliationCommands } from "./ProviderRuntimeIngestion.reconcile.ts";

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

  const reconcileThreadSessionsAtStartup = Effect.fn("reconcileThreadSessionsAtStartup")(
    function* () {
      const [readModel, liveSessions] = yield* Effect.all([
        orchestrationEngine.getReadModel(),
        providerService.listSessions(),
      ]);
      const occurredAt = new Date().toISOString();
      const commands = buildStartupReconciliationCommands({
        threads: readModel.threads,
        liveSessions,
        occurredAt,
      });

      yield* Effect.forEach(
        commands,
        (command) => orchestrationEngine.dispatch(command).pipe(Effect.asVoid),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);

      if (commands.length > 0) {
        yield* Effect.logInfo("provider runtime ingestion reconciled thread sessions at startup", {
          reconciledCount: commands.length,
          liveSessionCount: liveSessions.length,
        });
      }
    },
  );

  const start: ProviderRuntimeIngestionShape["start"] = Effect.fn("start")(function* () {
    yield* reconcileThreadSessionsAtStartup().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider runtime ingestion failed to reconcile thread sessions", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        getOrCreateThreadWorker(event.threadId).pipe(
          Effect.flatMap((worker) => worker.enqueue({ source: "runtime", event })),
        ),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
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
