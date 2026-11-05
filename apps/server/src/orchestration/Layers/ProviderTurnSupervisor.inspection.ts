import { Effect } from "effect";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { ProviderRuntimeIngestionShape } from "../Services/ProviderRuntimeIngestion.ts";
import {
  ensureOrchestrationThreadState,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

/** Durable replay is independent of liveness claims and native process ownership after restart. */
export const replayInspectionTerminals = Effect.fn("replayInspectionTerminals")(function* (input: {
  readonly providerService: ProviderServiceShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly reconcileInspection?: ProviderRuntimeIngestionShape["reconcileInspection"];
}) {
  const service = input.providerService;
  if (
    !service.listInspectionTerminals ||
    !service.publishInspectionTerminal ||
    !input.reconcileInspection
  )
    return;
  for (const record of yield* service.listInspectionTerminals()) {
    yield* Effect.gen(function* () {
      const event = record.terminal;
      yield* ensureOrchestrationThreadState(input.orchestrationEngine, event.threadId, "history");
      const owns = Effect.gen(function* () {
        const thread = (yield* input.orchestrationEngine.getReadModel()).threads.find(
          (entry) => entry.id === event.threadId,
        );
        return (
          thread !== undefined &&
          thread.deletedAt === null &&
          thread.deletingAt === null &&
          thread.session !== null &&
          thread.session !== undefined &&
          (thread.session.sessionEpoch ?? 0) === event.sessionEpoch &&
          (thread.session.activeTurnId === event.turnId ||
            (thread.session.activeTurnId === null && thread.latestTurn?.turnId === event.turnId))
        );
      });
      if (!(yield* owns)) return;
      if (!(yield* input.reconcileInspection!(record.items))) return;
      if (!(yield* owns)) return;
      if (
        event.type !== "turn.completed" ||
        (event.payload.state !== "completed" && event.payload.state !== "failed") ||
        !event.turnId
      )
        return;
      const confirmation = yield* (
        service.confirmInspectedTurn?.({
          threadId: event.threadId,
          turnId: event.turnId,
          sessionEpoch: event.sessionEpoch ?? 0,
          status: event.payload.state,
          publication: event,
        }) ?? Effect.succeed("rejected" as const)
      );
      if (confirmation !== "confirmed" && confirmation !== "absent") return;
      if (!(yield* owns)) return;
      yield* service.publishInspectionTerminal!(record);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("inspected terminal replay remains pending", {
          threadId: record.terminal.threadId,
          cause,
        }),
      ),
    );
  }
});
