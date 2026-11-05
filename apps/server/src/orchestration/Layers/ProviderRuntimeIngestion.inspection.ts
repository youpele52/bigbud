import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { Deferred, Effect } from "effect";
import type { RuntimeIngestionInput } from "./ProviderRuntimeIngestion.helpers.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { InspectionReconciliationError } from "../Services/ProviderRuntimeIngestion.ts";
import type { ProviderRuntimeIngestionShape } from "../Services/ProviderRuntimeIngestion.ts";
import type { DrainableWorker } from "@bigbud/shared/DrainableWorker";

export type RuntimeIngestionQueueInput =
  | RuntimeIngestionInput
  | {
      readonly source: "inspection";
      readonly events: ReadonlyArray<ProviderRuntimeEvent>;
      readonly ack: Deferred.Deferred<boolean, InspectionReconciliationError>;
    };

/** Uses the same per-thread worker and processor as live items, with explicit failure acknowledgement. */
export function processInspectionItems<E>(
  input: Extract<RuntimeIngestionQueueInput, { source: "inspection" }>,
  engine: OrchestrationEngineShape,
  process: (event: ProviderRuntimeEvent) => Effect.Effect<void, E>,
) {
  return Effect.gen(function* () {
    for (const event of input.events) {
      const thread = (yield* engine.getReadModel()).threads.find(
        (entry) => entry.id === event.threadId,
      );
      if (
        !thread ||
        thread.deletedAt !== null ||
        thread.deletingAt !== null ||
        (thread.session?.activeTurnId !== event.turnId &&
          !(thread.session?.activeTurnId === null && thread.latestTurn?.turnId === event.turnId)) ||
        (thread.session?.sessionEpoch ?? 0) !== event.sessionEpoch
      )
        return false;
      yield* process(event);
    }
    return true;
  }).pipe(
    Effect.catchCause((cause) => Effect.fail(new InspectionReconciliationError({ cause }))),
    Effect.exit,
    Effect.flatMap((exit) => Deferred.done(input.ack, exit)),
    Effect.asVoid,
  );
}

export function makeReconcileInspection(
  getWorker: (threadId: string) => Effect.Effect<DrainableWorker<RuntimeIngestionQueueInput>>,
): NonNullable<ProviderRuntimeIngestionShape["reconcileInspection"]> {
  return (events) =>
    Effect.gen(function* () {
      const first = events[0];
      if (!first) return true;
      if (
        events.some(
          (event) =>
            event.threadId !== first.threadId ||
            event.turnId !== first.turnId ||
            event.sessionEpoch !== first.sessionEpoch,
        )
      )
        return false;
      const ack = yield* Deferred.make<boolean, InspectionReconciliationError>();
      const worker = yield* getWorker(first.threadId);
      yield* worker.enqueue({ source: "inspection", events, ack });
      return yield* Deferred.await(ack);
    });
}
