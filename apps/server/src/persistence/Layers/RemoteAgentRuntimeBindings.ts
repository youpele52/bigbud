import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeRemoteAgentMaintenance } from "../../remote-agent/remoteAgentInstall.maintenance.ts";
import {
  configureRemoteAgentOwners,
  parseRemoteAgentOwner,
  parseRemoteAgentBinding,
  type RemoteAgentOwnerStore,
} from "../../remote-agent/remoteAgentOwners.ts";
import { MAX_REMOTE_AGENT_TERMINAL_OWNERS } from "../../remote-agent/remoteAgentInstall.registry.ts";
import { remoteAgentReplayFence } from "./RemoteAgentRuntimeBindings.replay.ts";
import { isRemoteAgentControllerAlive } from "../../remote-agent/remoteAgentController.ts";

const MAX_INACTIVE_BINDINGS = 16;

export const makeRemoteAgentRuntimeBindings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const replayFence = remoteAgentReplayFence(sql);
  yield* sql`PRAGMA synchronous = FULL`;
  const run = Effect.runPromiseWith(yield* Effect.services<SqlClient.SqlClient>());
  const read = async (key: string) => {
    const rows = await run(
      sql<{
        route_json: string;
        revision: number;
      }>`SELECT route_json, revision FROM remote_agent_runtime_owners WHERE owner_key = ${key}`,
    );
    const row = rows[0];
    return row
      ? { owner: parseRemoteAgentOwner(row.route_json), revision: row.revision }
      : undefined;
  };
  const pruneTerminal = async () => {
    const result = await run(
      sql.withTransaction(
        Effect.gen(function* () {
          const expired = yield* sql<{
            owner_key: string;
          }>`SELECT owner_key FROM remote_agent_runtime_owners
          WHERE json_extract(route_json, '$.state') = 'terminal'
          AND rowid NOT IN (SELECT rowid FROM remote_agent_runtime_owners
            WHERE json_extract(route_json, '$.state') = 'terminal'
            ORDER BY rowid DESC LIMIT ${MAX_REMOTE_AGENT_TERMINAL_OWNERS})`;
          for (const row of expired) yield* replayFence.remember(row.owner_key);
          return yield* sql`DELETE FROM remote_agent_runtime_owners
          WHERE json_extract(route_json, '$.state') = 'terminal'
            AND rowid NOT IN (
              SELECT rowid FROM remote_agent_runtime_owners
              WHERE json_extract(route_json, '$.state') = 'terminal'
              ORDER BY rowid DESC LIMIT ${MAX_REMOTE_AGENT_TERMINAL_OWNERS}
            )
          RETURNING owner_key`;
        }),
      ),
    );
    return result.length;
  };
  return {
    getBinding: async (target) => {
      const rows = await run(
        sql<{
          binding_json: string;
        }>`SELECT binding.binding_json FROM remote_agent_target_admissions AS selected JOIN remote_agent_connection_bindings AS binding ON binding.target_id = selected.target_id AND binding.connection_id = selected.connection_id WHERE selected.target_id = ${target}`,
      );
      return rows[0] ? parseRemoteAgentBinding(rows[0].binding_json) : undefined;
    },
    bindConnection: async (target, connectionId, binding) => {
      const text = JSON.stringify(
        parseRemoteAgentBinding(JSON.stringify({ ...binding, connectionId })),
      );
      await run(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO remote_agent_connection_bindings (target_id, connection_id, binding_json) VALUES (${target}, ${connectionId}, ${text}) ON CONFLICT(target_id, connection_id) DO NOTHING`;
            const rows = yield* sql<{
              binding_json: string;
            }>`SELECT binding_json FROM remote_agent_connection_bindings WHERE target_id = ${target} AND connection_id = ${connectionId}`;
            if (rows[0]?.binding_json !== text)
              return yield* Effect.die(new Error("Logical connection identity conflict."));
            yield* sql`INSERT INTO remote_agent_target_admissions (target_id, connection_id) VALUES (${target}, ${connectionId}) ON CONFLICT(target_id) DO UPDATE SET connection_id = excluded.connection_id`;
            yield* sql`DELETE FROM remote_agent_connection_bindings WHERE target_id = ${target} AND connection_id <> ${connectionId} AND rowid NOT IN (SELECT rowid FROM remote_agent_connection_bindings WHERE target_id = ${target} AND connection_id <> ${connectionId} ORDER BY rowid DESC LIMIT ${MAX_INACTIVE_BINDINGS})`;
          }),
        ),
      );
    },
    hasDurableReferences: async (target, connectionId) => {
      const rows = await run(
        sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM remote_agent_runtime_owners WHERE json_extract(route_json, '$.target') = ${target} AND json_extract(route_json, '$.connectionId') = ${connectionId} AND json_extract(route_json, '$.state') <> 'terminal' UNION ALL SELECT COUNT(*) AS count FROM remote_agent_target_admissions WHERE target_id = ${target} AND connection_id = ${connectionId}`,
      );
      return rows.some((row) => Number(row.count) > 0);
    },
    listConnectionIds: async (target) => {
      const rows = await run(
        sql<{
          connection_id: string;
        }>`SELECT connection_id FROM remote_agent_connection_bindings WHERE target_id = ${target}`,
      );
      return rows.map((row) => row.connection_id);
    },
    get: async (key) => (await read(key))?.owner,
    reserve: async (owner, replaceTerminal = false) => {
      const text = JSON.stringify(parseRemoteAgentOwner(JSON.stringify(owner)));
      const saved = await run(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              route_json: string;
            }>`SELECT route_json FROM remote_agent_runtime_owners WHERE owner_key = ${owner.ownerKey}`;
            if (!existing.length) yield* replayFence.assertNew(owner.ownerKey);
            const previous = existing[0]
              ? parseRemoteAgentOwner(existing[0].route_json)
              : undefined;
            if (
              replaceTerminal &&
              previous?.state === "terminal" &&
              previous.invocationId !== owner.invocationId
            ) {
              yield* replayFence.assertNew(JSON.stringify([owner.ownerKey, owner.invocationId]));
              yield* replayFence.remember(JSON.stringify([owner.ownerKey, previous.invocationId]));
            }
            yield* sql`INSERT INTO remote_agent_runtime_owners (owner_key, route_json) VALUES (${owner.ownerKey}, ${text}) ON CONFLICT(owner_key) DO NOTHING`;
            if (replaceTerminal)
              yield* sql`UPDATE remote_agent_runtime_owners SET route_json = ${text}, revision = revision + 1 WHERE owner_key = ${owner.ownerKey} AND json_extract(route_json, '$.state') = 'terminal'`;
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
              yield* sql`UPDATE remote_agent_runtime_owners SET route_json = ${text}, revision = revision + 1 WHERE owner_key = ${owner.ownerKey} AND json_extract(route_json, '$.state') = 'prepared' AND json_extract(route_json, '$.resourceId') = ${previous.resourceId}`;
            const rows = yield* sql<{
              route_json: string;
            }>`SELECT route_json FROM remote_agent_runtime_owners WHERE owner_key = ${owner.ownerKey}`;
            return rows[0]?.route_json;
          }),
        ),
      );
      if (!saved) throw new Error("Owner reservation did not persist.");
      return parseRemoteAgentOwner(saved);
    },
    rollbackPrepared: async (key, resourceId) => {
      const result = await run(
        sql`DELETE FROM remote_agent_runtime_owners WHERE owner_key = ${key} AND json_extract(route_json, '$.resourceId') = ${resourceId} AND json_extract(route_json, '$.state') = 'prepared' RETURNING owner_key`,
      );
      return result.length > 0;
    },
    update: async (key, transition) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const row = await read(key);
        if (!row) throw new Error("Durable owner is missing; dispatch is forbidden.");
        const next = parseRemoteAgentOwner(JSON.stringify(transition(row.owner)));
        if (
          next.ownerKey !== key ||
          next.resourceId !== row.owner.resourceId ||
          next.target !== row.owner.target ||
          next.epoch !== row.owner.epoch ||
          next.connectionId !== row.owner.connectionId ||
          next.controllerId !== row.owner.controllerId ||
          next.controllerPid !== row.owner.controllerPid ||
          next.controllerStartedAt !== row.owner.controllerStartedAt ||
          next.invocationId !== row.owner.invocationId ||
          next.outputSequence < row.owner.outputSequence ||
          next.nextInputSequence < row.owner.nextInputSequence ||
          next.inputAcknowledged < row.owner.inputAcknowledged ||
          (row.owner.state === "terminal" && next.state !== "terminal") ||
          JSON.stringify(next.runtime) !== JSON.stringify(row.owner.runtime) ||
          next.digest !== row.owner.digest
        )
          throw new Error("A durable owner cannot change runtime or wire identity.");
        const result = await run(
          sql`UPDATE remote_agent_runtime_owners SET route_json = ${JSON.stringify(next)}, revision = revision + 1 WHERE owner_key = ${key} AND revision = ${row.revision} RETURNING revision`,
        );
        if (result.length) {
          if (next.state === "terminal") await pruneTerminal();
          return next;
        }
      }
      throw new Error("Owner update contention exceeded retry budget.");
    },
    referencedBuildIds: async (target) => {
      const owners = await run(
        sql<{
          build_id: string;
        }>`SELECT json_extract(route_json, '$.runtime.version') || ':' || json_extract(route_json, '$.runtime.sha256') || ':' || json_extract(route_json, '$.runtime.targetTriple') || CASE WHEN json_extract(route_json, '$.runtime.origin') = 'legacy-external' THEN ':legacy' ELSE '' END AS build_id FROM remote_agent_runtime_owners WHERE json_extract(route_json, '$.target') = ${target} AND json_extract(route_json, '$.state') <> 'terminal'`,
      );
      const selected = await run(
        sql<{
          binding_json: string;
        }>`SELECT binding.binding_json FROM remote_agent_target_admissions AS selected JOIN remote_agent_connection_bindings AS binding ON binding.target_id = selected.target_id AND binding.connection_id = selected.connection_id WHERE selected.target_id = ${target}`,
      );
      return new Set([
        ...owners.map((row) => row.build_id),
        ...selected.map((row) => {
          const binding = parseRemoteAgentBinding(row.binding_json);
          return `${binding.runtime.version}:${binding.runtime.sha256}:${binding.runtime.targetTriple}${binding.runtime.origin === "legacy-external" ? ":legacy" : ""}`;
        }),
      ]);
    },
    knownTargets: async () => {
      const targets = await run(sql<{ target_id: string }>`
        SELECT target_id FROM remote_agent_target_admissions
        ORDER BY target_id LIMIT 128
      `);
      return targets.map((target) => target.target_id);
    },
    pruneTerminal,
  } satisfies RemoteAgentOwnerStore;
});

export const RemoteAgentRuntimeBindingsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* makeRemoteAgentRuntimeBindings;
    const sql = yield* SqlClient.SqlClient;
    const checks = [
      {
        read: (cursor: string) =>
          sql<{
            key: string;
            json: string;
          }>`SELECT owner_key AS key, route_json AS json FROM remote_agent_runtime_owners WHERE owner_key > ${cursor} AND json_extract(route_json, '$.state') <> 'terminal' ORDER BY owner_key LIMIT 250`,
        decode: parseRemoteAgentOwner,
      },
      {
        read: (cursor: string) =>
          sql<{
            key: string;
            json: string;
          }>`SELECT CAST(rowid AS TEXT) AS key, binding_json AS json FROM remote_agent_connection_bindings WHERE rowid > CAST(${cursor || "0"} AS INTEGER) ORDER BY rowid LIMIT 250`,
        decode: parseRemoteAgentBinding,
      },
    ];
    for (const check of checks) {
      let cursor = "";
      while (true) {
        const rows = yield* check.read(cursor);
        for (const row of rows) check.decode(row.json);
        const last = rows.at(-1);
        if (!last) break;
        cursor = last.key;
      }
    }
    configureRemoteAgentOwners(store);
    yield* Effect.promise(() => store.pruneTerminal?.().then(() => undefined) ?? Promise.resolve());
    const maintenance = yield* makeRemoteAgentMaintenance;
    const targets = yield* sql<{
      target_id: string;
    }>`SELECT DISTINCT target_id FROM remote_agent_target_admissions LIMIT 128`;
    for (const target of targets) {
      yield* sql`DELETE FROM remote_agent_connection_bindings WHERE target_id = ${target.target_id} AND connection_id <> (SELECT connection_id FROM remote_agent_target_admissions WHERE target_id = ${target.target_id}) AND rowid NOT IN (SELECT rowid FROM remote_agent_connection_bindings WHERE target_id = ${target.target_id} AND connection_id <> (SELECT connection_id FROM remote_agent_target_admissions WHERE target_id = ${target.target_id}) ORDER BY rowid DESC LIMIT ${MAX_INACTIVE_BINDINGS})`;
      maintenance.schedule(target.target_id);
    }
  }),
);
