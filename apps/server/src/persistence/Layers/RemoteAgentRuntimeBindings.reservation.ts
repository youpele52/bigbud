import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  parseRemoteAgentOwner,
  type RemoteAgentOwnerStore,
} from "../../remote-agent/remoteAgentOwners.ts";
import { isRemoteAgentControllerAlive } from "../../remote-agent/remoteAgentController.ts";
import { remoteAgentReplayFence } from "./RemoteAgentRuntimeBindings.replay.ts";

/** One canonical SQL writer and replay fence; optional local scope never changes SSH defaults. */
export const makeRemoteAgentRuntimeReservations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const replayFence = remoteAgentReplayFence(sql);
  const run = Effect.runPromiseWith(yield* Effect.services<SqlClient.SqlClient>());
  return {
    reserve: async (owner, replaceTerminal = false, expectedTarget?: string) => {
      const intent = parseRemoteAgentOwner(JSON.stringify(owner));
      if (expectedTarget !== undefined && intent.target !== expectedTarget)
        throw new Error("Owner reservation belongs to another target.");
      const text = JSON.stringify(intent);
      const saved = await run(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              route_json: string;
            }>`SELECT route_json FROM remote_agent_runtime_owners WHERE owner_key = ${intent.ownerKey}`;
            if (!existing.length) yield* replayFence.assertNew(intent.ownerKey);
            const previous = existing[0]
              ? parseRemoteAgentOwner(existing[0].route_json)
              : undefined;
            if (expectedTarget !== undefined && previous && previous.target !== expectedTarget)
              return yield* Effect.die(new Error("Existing owner belongs to another target."));
            if (
              replaceTerminal &&
              previous?.state === "terminal" &&
              previous.invocationId !== intent.invocationId
            ) {
              yield* replayFence.assertNew(JSON.stringify([intent.ownerKey, intent.invocationId]));
              yield* replayFence.remember(JSON.stringify([intent.ownerKey, previous.invocationId]));
            }
            yield* sql`INSERT INTO remote_agent_runtime_owners (owner_key, route_json) VALUES (${intent.ownerKey}, ${text}) ON CONFLICT(owner_key) DO NOTHING`;
            if (replaceTerminal)
              yield* sql`UPDATE remote_agent_runtime_owners SET route_json = ${text}, revision = revision + 1 WHERE owner_key = ${intent.ownerKey} AND json_extract(route_json, '$.state') = 'terminal' AND (${expectedTarget ?? null} IS NULL OR (json_extract(route_json, '$.target') = ${expectedTarget ?? null} AND json_extract(route_json, '$.resourceId') = ${previous?.resourceId ?? null}))`;
            if (
              previous?.state === "prepared" &&
              previous.controllerId !== undefined &&
              previous.controllerPid !== undefined &&
              previous.controllerStartedAt !== undefined &&
              !(yield* Effect.promise(() =>
                isRemoteAgentControllerAlive({
                  id: previous.controllerId!,
                  pid: previous.controllerPid!,
                  startedAt: previous.controllerStartedAt!,
                }),
              ))
            )
              yield* sql`UPDATE remote_agent_runtime_owners SET route_json = ${text}, revision = revision + 1 WHERE owner_key = ${intent.ownerKey} AND json_extract(route_json, '$.state') = 'prepared' AND json_extract(route_json, '$.resourceId') = ${previous.resourceId} AND (${expectedTarget ?? null} IS NULL OR json_extract(route_json, '$.target') = ${expectedTarget ?? null})`;
            const rows = yield* sql<{
              route_json: string;
            }>`SELECT route_json FROM remote_agent_runtime_owners WHERE owner_key = ${intent.ownerKey}`;
            if (!rows[0]) return yield* Effect.die(new Error("Owner reservation did not persist."));
            const retained = parseRemoteAgentOwner(rows[0].route_json);
            if (expectedTarget !== undefined && retained.target !== expectedTarget)
              return yield* Effect.die(new Error("Retained owner belongs to another target."));
            return retained;
          }),
        ),
      );
      return saved;
    },
    rollbackPrepared: async (key, resourceId, expectedTarget?: string) => {
      if (expectedTarget !== undefined && (typeof expectedTarget !== "string" || !expectedTarget))
        throw new Error("Invalid owner rollback target.");
      const result = await run(
        sql`DELETE FROM remote_agent_runtime_owners WHERE owner_key = ${key} AND json_extract(route_json, '$.resourceId') = ${resourceId} AND json_extract(route_json, '$.state') = 'prepared' AND (${expectedTarget ?? null} IS NULL OR json_extract(route_json, '$.target') = ${expectedTarget ?? null}) RETURNING owner_key`,
      );
      return result.length > 0;
    },
  } satisfies Pick<RemoteAgentOwnerStore, "reserve" | "rollbackPrepared">;
});
