import { type OrchestrationEvent } from "@bigbud/contracts";
import { Cause, Effect, Layer, Option, Scope, Stream } from "effect";
import { type DrainableWorker, makeDrainableWorker } from "@bigbud/shared/DrainableWorker";

import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { makeProviderCommandHandlers } from "./ProviderCommandReactorHandlers.ts";
import { DirectResourceCleanupRepository } from "../../persistence/Services/DirectResourceCleanupRepository.ts";
import { makeDirectResourceCleanupRepository } from "../../persistence/Layers/DirectResourceCleanupRepository.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "project.deletion-requested"
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.message-sent"
      | "thread.turn-interrupt-requested"
      | "thread.turn-steer-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.deletion-requested";
  }
>;

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const handlers = yield* makeProviderCommandHandlers;
  const cleanupRepositoryService = yield* Effect.serviceOption(DirectResourceCleanupRepository);
  const cleanupRepository = Option.isSome(cleanupRepositoryService)
    ? cleanupRepositoryService.value
    : yield* makeDirectResourceCleanupRepository;

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    handlers.processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  // Per-thread worker map: each thread gets its own DrainableWorker so that
  // a slow operation on one thread (e.g. spawning the Codex process) does not
  // block intent events for any other thread.
  const aggregateWorkers = new Map<string, DrainableWorker<ProviderIntentEvent>>();
  const outerScope = yield* Effect.scope;

  const getOrCreateAggregateWorker = (
    aggregateKey: string,
  ): Effect.Effect<DrainableWorker<ProviderIntentEvent>> => {
    const existing = aggregateWorkers.get(aggregateKey);
    if (existing !== undefined) {
      return Effect.succeed(existing);
    }
    return makeDrainableWorker(processDomainEventSafely).pipe(
      Effect.provideService(Scope.Scope, outerScope),
      Effect.tap((worker) => Effect.sync(() => aggregateWorkers.set(aggregateKey, worker))),
    );
  };

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "project.deletion-requested" ||
        event.type === "thread.meta-updated" ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.message-sent" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.turn-steer-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.deletion-requested"
      ) {
        const worker = yield* getOrCreateAggregateWorker(
          "projectId" in event.payload
            ? `project:${event.payload.projectId}`
            : `thread:${event.payload.threadId}`,
        );
        return yield* worker.enqueue(event);
      }
    });

    // Subscribe before either durable scan. The scans are the startup fence: any
    // intent committed before subscription is found below, while later intents
    // are delivered to the live worker stream.
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
    yield* Effect.yieldNow;

    let cursorAt = "";
    let cursorId = "";
    while (true) {
      const intents = yield* cleanupRepository
        .listRecoverableIntents({
          requestedAfter: cursorAt,
          intentAfter: cursorId,
          limit: 100,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("provider command reactor could not inspect cleanup intents", {
              detail: String(error),
            }).pipe(Effect.as([])),
          ),
        );
      yield* Effect.forEach(
        intents,
        (intent) =>
          orchestrationEngine.readEventsByCommandId!(intent.commandId as never).pipe(
            Effect.flatMap((events) => {
              const event = events.find((candidate) => candidate.eventId === intent.eventId);
              return event &&
                (event.type === "thread.deletion-requested" ||
                  event.type === "project.deletion-requested")
                ? processEvent(event)
                : Effect.void;
            }),
            Effect.catch((error) =>
              Effect.logWarning("provider command reactor could not recover cleanup intent", {
                eventId: intent.eventId,
                detail: String(error),
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
      const last = intents.at(-1);
      if (!last || intents.length < 100) break;
      cursorAt = last.requestedAt;
      cursorId = last.intentId;
    }
  });

  return {
    start,
    // Lazily capture workers at drain time so newly-created thread workers are
    // included. Runs all active per-thread drain effects concurrently.
    drain: Effect.suspend(() =>
      Effect.forEach(Array.from(aggregateWorkers.values()), (worker) => worker.drain, {
        concurrency: "unbounded",
      }),
    ).pipe(Effect.asVoid),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
