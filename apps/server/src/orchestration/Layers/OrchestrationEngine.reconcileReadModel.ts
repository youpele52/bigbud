import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import type { OrchestrationEventStoreShape } from "../../persistence/Services/OrchestrationEventStore.ts";
import { projectEvent } from "../projector.ts";

export function reconcileCommittedReadModel(
  eventStore: OrchestrationEventStoreShape,
  sequence: number,
  input: {
    readonly readModel: () => OrchestrationReadModel;
    readonly setReadModel: (value: OrchestrationReadModel) => void;
    readonly publishDomainEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
  },
) {
  return Effect.gen(function* () {
    const events = yield* Stream.runCollect(eventStore.readFromSequence(sequence));
    let nextReadModel = input.readModel();
    if (events.length === 0) return;
    for (const event of events) nextReadModel = yield* projectEvent(nextReadModel, event);
    input.setReadModel(nextReadModel);
    for (const event of events) yield* input.publishDomainEvent(event);
  });
}
