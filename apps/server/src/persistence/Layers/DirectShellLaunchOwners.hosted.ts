/**
 * Version 2 rows of `direct_shell_launch_owners`: Direct SSH panes whose ssh client runs in the
 * local terminal host (plan M7). They share the table's capacity and pane-key uniqueness with
 * legacy owners, so a pane holds either kind, never both.
 *
 * @module DirectShellLaunchOwners.hosted
 */
import type * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  isHostedDirectShellRecord,
  parseHostedDirectShellOwner,
  withHostedRemoteShellPid,
  type HostedDirectShellOwnerStore,
} from "../../terminal/Layers/DirectShellLaunch.hosted";

type OwnerRow = {
  owner_key: string;
  reservation_id: string;
  controller_id: string;
  state: string;
  owner_json: string;
};
type Run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;

export function makeHostedDirectShellOwners(
  run: Run,
  sql: SqlClient.SqlClient,
  readRow: (key: string) => Promise<OwnerRow | undefined>,
  maxOwners: number,
): HostedDirectShellOwnerStore {
  const decode = (row: OwnerRow) => {
    const json: unknown = JSON.parse(row.owner_json);
    if (!isHostedDirectShellRecord(json)) return undefined;
    const owner = parseHostedDirectShellOwner(json);
    if (
      owner.ownerKey !== row.owner_key ||
      owner.reservationId !== row.reservation_id ||
      owner.controllerId !== row.controller_id ||
      owner.state !== row.state
    )
      throw new Error("Hosted direct shell record storage identity conflict.");
    return owner;
  };
  const getHosted = async (key: string) => {
    const row = await readRow(key);
    return row ? decode(row) : undefined;
  };
  return {
    getHosted,
    reserveHosted: async (input) => {
      const owner = parseHostedDirectShellOwner(input);
      const text = JSON.stringify(owner);
      const inserted = await run(sql`INSERT INTO direct_shell_launch_owners
        (owner_key, reservation_id, controller_id, state, owner_json)
        SELECT ${owner.ownerKey}, ${owner.reservationId}, ${owner.controllerId}, ${owner.state},
          ${text}
        WHERE (SELECT COUNT(*) FROM direct_shell_launch_owners) < ${maxOwners}
        ON CONFLICT(owner_key) DO NOTHING RETURNING owner_key`);
      const row = await readRow(owner.ownerKey);
      if (!row)
        throw new Error("Direct shell owner capacity or persistence prevented reservation.");
      const saved = decode(row);
      if (!saved)
        throw new Error(
          "This pane retains an unconfirmed direct shell owner; no SSH terminal was started.",
        );
      return { created: inserted.length === 1, owner: saved };
    },
    releaseHosted: async (input) => {
      const owner = parseHostedDirectShellOwner(input);
      const rows = await run(sql`DELETE FROM direct_shell_launch_owners
        WHERE owner_key = ${owner.ownerKey} AND reservation_id = ${owner.reservationId}
          AND owner_json = ${JSON.stringify(owner)} RETURNING owner_key`);
      return rows.length === 1;
    },
    setHostedRemoteShellPid: async (input, remoteShellPid) => {
      const owner = parseHostedDirectShellOwner(input);
      const next = withHostedRemoteShellPid(owner, remoteShellPid);
      const rows = await run(sql`UPDATE direct_shell_launch_owners
        SET owner_json = ${JSON.stringify(next)}
        WHERE owner_key = ${owner.ownerKey} AND reservation_id = ${owner.reservationId}
          AND owner_json = ${JSON.stringify(owner)} RETURNING owner_key`);
      return rows.length === 1 ? next : undefined;
    },
    listHostedForThread: async (threadId) => {
      const rows =
        await run(sql<OwnerRow>`SELECT owner_key, reservation_id, controller_id, state, owner_json
        FROM direct_shell_launch_owners`);
      return rows.flatMap((row) => {
        const owner = decode(row);
        return owner && owner.pane.threadId === threadId ? [owner] : [];
      });
    },
  };
}
