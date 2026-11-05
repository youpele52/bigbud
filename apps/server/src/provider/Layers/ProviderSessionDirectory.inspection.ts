import { Effect, Schema } from "effect";
import type { ProviderSessionRuntimeRepositoryShape } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError } from "../Errors.ts";
import { InspectionTerminal } from "../Services/ProviderInspectionTerminal.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";

const failure = (cause: unknown) =>
  new ProviderSessionDirectoryPersistenceError({
    operation: "ProviderSessionDirectory.inspectionTerminal",
    detail: "Durable inspected terminal journal operation failed.",
    cause,
  });

/** Preserve replay material until ingestion, checkpoints, and recovery have all acknowledged it. */
export function makeDirectoryInspection(
  repository: ProviderSessionRuntimeRepositoryShape,
): Pick<
  ProviderSessionDirectoryShape,
  "storeInspectionTerminal" | "acknowledgeInspectionTerminal" | "listInspectionTerminals"
> {
  return {
    storeInspectionTerminal: (record) =>
      Effect.gen(function* () {
        const event = record.terminal;
        if (
          !repository.storeInspectionTerminal ||
          event.type !== "turn.completed" ||
          event.sessionEpoch === undefined
        )
          return yield* failure("Atomic terminal journal storage is unavailable.");
        const stored = yield* repository
          .storeInspectionTerminal(
            event.threadId,
            record,
            event.eventId,
            event.sessionEpoch,
            record.nativeThreadId,
          )
          .pipe(Effect.mapError(failure));
        if (!stored)
          return yield* failure(
            "The terminal journal binding changed or a previous outcome remains unpublished.",
          );
      }),
    acknowledgeInspectionTerminal: (threadId, eventId, consumer) =>
      repository.acknowledgeInspectionTerminal
        ? repository
            .acknowledgeInspectionTerminal(threadId, eventId, consumer)
            .pipe(Effect.mapError(failure))
        : Effect.fail(failure("Terminal journal acknowledgement is unavailable.")),
    listInspectionTerminals: (after) =>
      repository.listInspectionTerminals
        ? repository.listInspectionTerminals(after).pipe(
            Effect.mapError(failure),
            Effect.flatMap((rows) =>
              Effect.forEach(rows, (row) =>
                Schema.decodeUnknownEffect(InspectionTerminal)(row.record).pipe(
                  Effect.mapError(failure),
                  Effect.flatMap((record) =>
                    record.terminal.threadId === row.threadId
                      ? Effect.succeed(record)
                      : Effect.fail(failure("Journal owner mismatch.")),
                  ),
                ),
              ),
            ),
          )
        : Effect.fail(failure("Terminal journal listing is unavailable.")),
  };
}
