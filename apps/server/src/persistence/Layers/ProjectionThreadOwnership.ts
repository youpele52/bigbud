import type { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const assertProjectionThreadParent = Effect.fn("assertProjectionThreadParent")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const parent = yield* sql<{ readonly threadId: ThreadId }>`
    SELECT thread_id AS "threadId" FROM projection_threads WHERE thread_id = ${threadId}
  `;
  if (parent[0] === undefined) {
    return yield* Effect.fail(new Error(`projection thread parent is missing: ${threadId}`));
  }
});
