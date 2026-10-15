import { Effect, Layer, Stream } from "effect";

import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadWatchRepository } from "../../persistence/Services/ProjectionThreadWatches.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadWatchReactor,
  type ThreadWatchReactorShape,
} from "../Services/ThreadWatchReactor.ts";
import { handleThreadWatchDomainEvent } from "./ThreadWatchReactor.logic.ts";
import { startDelegatedModelChoiceSupervision } from "./ThreadWatchReactor.modelChoice.ts";

const makeThreadWatchReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const repository = yield* ProjectionThreadWatchRepository;
  const activityRepository = yield* ProjectionThreadActivityRepository;

  const start: ThreadWatchReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.logDebug("thread watch reactor starting");

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        handleThreadWatchDomainEvent({
          repository,
          orchestrationEngine,
          event,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread watch event handling failed", {
              eventType: event.type,
              cause: cause.toString(),
            }),
          ),
        ),
      ),
    );
    // Held delegated first turns (delegated model choice) are supervised beside the watches.
    yield* startDelegatedModelChoiceSupervision({ orchestrationEngine, activityRepository });
  });

  return {
    start,
  } satisfies ThreadWatchReactorShape;
});

export const ThreadWatchReactorLive = Layer.effect(ThreadWatchReactor, makeThreadWatchReactor);
