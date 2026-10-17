import { Effect, Schedule } from "effect";
import type { ProviderTurnAdmissionsShape } from "../../../persistence/Services/ProviderTurnAdmissions.ts";

/** Bounded, non-dispatching startup inventory; unresolved admissions never license native replay. */
export const inspectV2Admissions = Effect.fn("inspectV2Admissions")(function* (
  journal: ProviderTurnAdmissionsShape,
) {
  const rows = yield* journal.listUnresolved(100);
  if (rows.length)
    yield* Effect.logWarning(
      "V2 unresolved admissions retained; automatic resend/rebinding is disabled",
      { boundedCount: rows.length, atLeast: rows.length === 100 },
    );
  return rows.length;
});

/** Lossless CAS compression only: immutable IDs, final records and deletion tombstones remain. */
export const maintainV2Admissions = Effect.fn("maintainV2Admissions")(function* (
  journal: ProviderTurnAdmissionsShape,
) {
  yield* journal.compactTerminal(25);
});

export const startV2AdmissionMaintenance = Effect.fn("startV2AdmissionMaintenance")(function* (
  journal: ProviderTurnAdmissionsShape,
) {
  yield* maintainV2Admissions(journal).pipe(
    Effect.catch((error) =>
      Effect.logWarning("V2 lossless journal maintenance failed; records retained", error),
    ),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );
});
