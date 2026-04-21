import { type OrchestrationEvent } from "@bigbud/contracts";
import { Cause, Effect, Layer, Scope, Stream } from "effect";
import { type DrainableWorker, makeDrainableWorker } from "@bigbud/shared/DrainableWorker";

import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { makeProviderCommandHandlers } from "./ProviderCommandReactorHandlers.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const handlers = yield* makeProviderCommandHandlers;

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
  const threadWorkers = new Map<string, DrainableWorker<ProviderIntentEvent>>();
  const outerScope = yield* Effect.scope;

  const getOrCreateThreadWorker = (
    threadId: string,
  ): Effect.Effect<DrainableWorker<ProviderIntentEvent>> => {
    const existing = threadWorkers.get(threadId);
    if (existing !== undefined) {
      return Effect.succeed(existing);
    }
    return makeDrainableWorker(processDomainEventSafely).pipe(
      Effect.provideService(Scope.Scope, outerScope),
      Effect.tap((worker) => Effect.sync(() => threadWorkers.set(threadId, worker))),
    );
  };

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        const worker = yield* getOrCreateThreadWorker(event.payload.threadId);
        return yield* worker.enqueue(event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
  });

  return {
    start,
    // Lazily capture workers at drain time so newly-created thread workers are
    // included. Runs all active per-thread drain effects concurrently.
    drain: Effect.suspend(() =>
      Effect.forEach(Array.from(threadWorkers.values()), (worker) => worker.drain, {
        concurrency: "unbounded",
      }),
    ).pipe(Effect.asVoid),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
