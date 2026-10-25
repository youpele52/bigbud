import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { canonicalWorktreePath, type WorktreePathResolver } from "./WorktreeReferences.ts";
import type { WorktreeOperationRow } from "./WorktreeReservations.ts";
import { preflightWorktreeOperation } from "./WorktreeLifecycle.preflight.ts";
import { worktreeFailure } from "./WorktreeInventory.ts";

/** Resolve aliases before taking the engine barrier; transactional revalidation performs no filesystem I/O. */
export function captureWorktreePreflight(
  sql: SqlClient.SqlClient,
  operation: WorktreeOperationRow,
  root: string,
) {
  return Effect.gen(function* () {
    const paths = new Map<string, string>();
    const capture: WorktreePathResolver = (value) =>
      canonicalWorktreePath(value).pipe(
        Effect.tap((resolved) =>
          Effect.sync(() => {
            paths.set(value, resolved);
          }),
        ),
      );
    yield* preflightWorktreeOperation(sql, operation, root, capture);
    const resolve: WorktreePathResolver = (value) => {
      const cached = paths.get(value);
      return cached === undefined
        ? Effect.fail(
            worktreeFailure(
              operation.cwd,
              "Workspace references changed during preparation. Refresh and try again.",
            ),
          )
        : Effect.succeed(cached);
    };
    return { resolve, verify: preflightWorktreeOperation(sql, operation, root, resolve) };
  });
}
