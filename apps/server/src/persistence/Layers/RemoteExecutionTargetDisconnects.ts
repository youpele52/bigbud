import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  configureSshTargetDisconnects,
  releaseSshTargetDisconnectStore,
  type SshTargetDisconnectStore,
} from "../../ssh/sshTargetDisconnects.ts";
import { createRemoteExecutionTargetDisconnectsTable } from "../RemoteExecutionTargetDisconnects.schema.ts";

/**
 * Loads user-initiated SSH target disconnects into the in-memory guard and
 * installs the SQLite store that keeps them across restarts.
 */
export const makeRemoteExecutionTargetDisconnects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const run = Effect.runPromiseWith(yield* Effect.services<SqlClient.SqlClient>());
  const store: SshTargetDisconnectStore = {
    persist: (targetId, disconnectedAt) =>
      run(
        sql`INSERT INTO remote_execution_target_disconnects (target_id, disconnected_at)
          VALUES (${targetId}, ${disconnectedAt})
          ON CONFLICT(target_id) DO NOTHING`,
      ).then(() => undefined),
    remove: (targetId) =>
      run(sql`DELETE FROM remote_execution_target_disconnects WHERE target_id = ${targetId}`).then(
        () => undefined,
      ),
  };
  // Still support callers that construct this layer without the full migrations.
  yield* createRemoteExecutionTargetDisconnectsTable(sql);
  const rows = yield* sql<{
    target_id: string;
  }>`SELECT target_id FROM remote_execution_target_disconnects ORDER BY target_id`;
  configureSshTargetDisconnects(
    store,
    rows.map((row) => row.target_id),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => releaseSshTargetDisconnectStore(store)));
  return store;
});

export const RemoteExecutionTargetDisconnectsLive = Layer.effectDiscard(
  makeRemoteExecutionTargetDisconnects,
);

/**
 * Wraps the server persistence layer so the disconnect flags are loaded before
 * any layer that receives `SqlClient` from it is built: remote-agent startup
 * maintenance, the update scheduler and every SSH consumer see them from the start.
 */
export const withRemoteExecutionTargetDisconnects = <A, E, R>(
  persistence: Layer.Layer<A | SqlClient.SqlClient, E, R>,
) => RemoteExecutionTargetDisconnectsLive.pipe(Layer.provideMerge(persistence));
