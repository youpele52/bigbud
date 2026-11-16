import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MAX_REMOTE_AGENT_TERMINAL_OWNERS } from "../../remote-agent/remoteAgentInstall.registry.ts";
import { parseRemoteAgentOwner } from "../../remote-agent/remoteAgentOwners.ts";
import { remoteAgentReplayFence } from "./RemoteAgentRuntimeBindings.replay.ts";

/** Keyset pages keep backend-restart discovery bounded without changing owner state. */
export const makeRemoteAgentOwnerInventory = Effect.fn("makeRemoteAgentOwnerInventory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const run = Effect.runPromiseWith(yield* Effect.services<SqlClient.SqlClient>());
    const replayFence = remoteAgentReplayFence(sql);
    const pruneTerminal = async (expectedTarget?: string) => {
      const result = await run(
        sql.withTransaction(
          Effect.gen(function* () {
            const expired = yield* sql<{
              owner_key: string;
            }>`DELETE FROM remote_agent_runtime_owners
              WHERE json_extract(route_json, '$.state') = 'terminal'
                AND (${expectedTarget ?? null} IS NULL OR json_extract(route_json, '$.target') = ${expectedTarget ?? null})
                AND rowid NOT IN (
                  SELECT rowid FROM remote_agent_runtime_owners
                  WHERE json_extract(route_json, '$.state') = 'terminal'
                    AND (${expectedTarget ?? null} IS NULL OR json_extract(route_json, '$.target') = ${expectedTarget ?? null})
                  ORDER BY rowid DESC LIMIT ${MAX_REMOTE_AGENT_TERMINAL_OWNERS}
                ) RETURNING owner_key`;
            for (const row of expired) yield* replayFence.remember(row.owner_key);
            return expired;
          }),
        ),
      );
      return result.length;
    };
    return {
      pruneTerminal,
      listTerminalOwners: async (target: string, after = "", limit = 100) => {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || after.length > 256)
          throw new Error("Invalid terminal owner inventory cursor or limit.");
        const rows = await run(sql<{ owner_key: string; route_json: string }>`
        SELECT owner_key, route_json FROM remote_agent_runtime_owners
        WHERE owner_key LIKE 'terminal:%' AND owner_key > ${after}
          AND json_extract(route_json, '$.target') = ${target}
        ORDER BY owner_key LIMIT ${limit + 1}`);
        const owners = rows.slice(0, limit).map((row) => {
          const owner = parseRemoteAgentOwner(row.route_json);
          if (owner.ownerKey !== row.owner_key || owner.target !== target)
            throw new Error("Terminal owner inventory identity mismatch.");
          return owner;
        });
        return { owners, nextCursor: rows.length > limit ? owners.at(-1)!.ownerKey : "" };
      },
    };
  },
);
