import { Deferred, Effect, Stream } from "effect";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { DesktopSupervisorDeliveryShape } from "../desktop-supervisor/desktopSupervisorDelivery.types.ts";
import type { DeliverySessionEndedInput } from "../connection-diagnostics/Services/ConnectionDiagnostics.ts";
import { makeOrderedOrchestrationDomainEventStream } from "./wsStreams.ts";
import {
  classifyHandoffExit,
  makeDeliveryEndReasonTracker,
} from "./wsOrchestrationDelivery.endReason.ts";

export const ORCHESTRATION_DELIVERY_LIVE_CAPACITY = 2_000;

export function makeOrchestrationDeliveryStream(input: {
  readonly consumerId: string;
  readonly appliedSequence: number;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly delivery: DesktopSupervisorDeliveryShape;
  readonly liveCapacity?: number;
  /** Observes why the session ended; never changes delivery behavior. */
  readonly onSessionEnded?: (input: DeliverySessionEndedInput) => Effect.Effect<void>;
  /** Lets a stream closed by server shutdown say so instead of reading as a client close. */
  readonly isServerShuttingDown?: () => boolean;
}) {
  return Effect.gen(function* () {
    const services = yield* Effect.services<never>();
    const runPromise = Effect.runPromiseWith(services);
    const canonicalStream = yield* makeOrderedOrchestrationDomainEventStream({
      orchestrationEngine: input.orchestrationEngine,
      nonBlockingLiveCapacity: input.liveCapacity ?? ORCHESTRATION_DELIVERY_LIVE_CAPACITY,
    });
    const endReason = makeDeliveryEndReasonTracker(input.isServerShuttingDown);
    const openedAt = Date.now();
    const subscription = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        input.delivery.open({
          consumerId: input.consumerId,
          appliedSequence: input.appliedSequence,
          readReplay: (sequence, limit) =>
            runPromise(input.orchestrationEngine.readReplay(sequence, limit)),
        }),
      ).pipe(Effect.orDie),
      (owned) =>
        Effect.sync(() => owned.close()).pipe(
          Effect.andThen(
            input.onSessionEnded?.({
              consumerId: input.consumerId,
              reason: endReason.resolve(owned),
              durationMs: Date.now() - openedAt,
            }) ?? Effect.void,
          ),
          Effect.ignoreCause,
        ),
    );
    const handoffEnded = yield* Deferred.make<void>();
    yield* Stream.runForEach(canonicalStream, (event: OrchestrationEvent) =>
      Effect.tryPromise(() => subscription.offer(event)).pipe(
        Effect.orDie,
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Effect.sync(() => endReason.mark("overflow")).pipe(
                Effect.andThen(
                  Effect.die(new Error("orchestration delivery live handoff overflowed")),
                ),
              ),
        ),
      ),
    ).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          const reason = classifyHandoffExit(exit);
          if (reason) endReason.mark(reason);
        }),
      ),
      Effect.catchCause(() => Effect.void),
      Effect.ensuring(
        Effect.sync(() => subscription.close()).pipe(
          Effect.andThen(Deferred.succeed(handoffEnded, undefined)),
        ),
      ),
      Effect.forkScoped,
    );
    const output = Stream.fromEffectRepeat(
      Effect.tryPromise(() => subscription.take()).pipe(Effect.orDie),
    ).pipe(
      Stream.takeWhile((item) => item !== null),
      Stream.map((item) => item!),
    );
    const handoffFailure = Stream.fromEffect(
      Deferred.await(handoffEnded).pipe(
        Effect.andThen(
          Effect.die(new Error("orchestration delivery live handoff requires resubscription")),
        ),
      ),
    );
    return Stream.merge(output, handoffFailure);
  });
}
