import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { backfillOrganizationAgePage } from "../../persistence/Layers/ProjectionThreads.agingBackfill.ts";

/** One scoped worker per pipeline instance, even across repeated bootstrap calls. No timers
 * choose candidates here: this only reconstructs projection provenance from recorded history.
 */
export const makeOrganizationAgeBackfill = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const running = yield* Ref.make(false);
    const scope = yield* Scope.Scope;
    const drain = Effect.gen(function* () {
      while (
        !(yield* backfillOrganizationAgePage(sql).pipe(
          Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") }),
        ))
      )
        yield* Effect.sleep("10 millis");
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          "organization age classification blocked after bounded retries; pending threads protected; restart/bootstrap retries classification",
          { cause: cause.toString() },
        ),
      ),
      Effect.ensuring(Ref.set(running, false)),
    );
    return Effect.gen(function* () {
      const start = yield* Ref.modify(running, (value) => [!value, true]);
      if (start) yield* drain.pipe(Effect.forkIn(scope));
    });
  });
