import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  parseDirectShellLaunchOwner,
  type DirectShellLaunchOwner,
  type DirectShellLaunchOwnerStore,
} from "../../terminal/Layers/DirectShellLaunch.owner";

import { verifyDirectShellTermination } from "../../terminal/Layers/DirectShellLaunch.lifecycle";

const MAX_OWNERS = 4096;

/**
 * Durable direct-transport dispatch fencing, not a remote PTY recovery service.
 * No possibly-dispatched owner is evicted, released on EOF, or automatically retried.
 * Manager composes this journal for exact SSH/WSL launches and refuses retained owners.
 */
export const makeDirectShellLaunchOwners = Effect.fn("makeDirectShellLaunchOwners")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA synchronous = FULL`;
  const run = Effect.runPromiseWith(yield* Effect.services<SqlClient.SqlClient>());
  type OwnerRow = {
    owner_key: string;
    reservation_id: string;
    controller_id: string;
    state: DirectShellLaunchOwner["state"];
    owner_json: string;
  };
  const decodeRow = (row: OwnerRow) => {
    const owner = parseDirectShellLaunchOwner(JSON.parse(row.owner_json));
    if (
      owner.ownerKey !== row.owner_key ||
      owner.reservationId !== row.reservation_id ||
      owner.controllerId !== row.controller_id ||
      owner.state !== row.state
    )
      throw new Error("Direct shell owner storage identity conflict.");
    return { owner, text: row.owner_json };
  };
  const read = async (key: string) => {
    const rows =
      await run(sql<OwnerRow>`SELECT owner_key, reservation_id, controller_id, state, owner_json
       FROM direct_shell_launch_owners WHERE owner_key = ${key}`);
    return rows[0] ? decodeRow(rows[0]) : undefined;
  };
  const transition = async (
    key: string,
    reservationId: string,
    controllerId: string,
    from: DirectShellLaunchOwner["state"],
    to: DirectShellLaunchOwner["state"],
  ) => {
    const current = await read(key);
    if (
      !current ||
      current.owner.reservationId !== reservationId ||
      current.owner.controllerId !== controllerId ||
      current.owner.state !== from
    )
      return false;
    const next = { ...current.owner, state: to };
    const rows = await run(sql`UPDATE direct_shell_launch_owners
      SET state = ${to}, owner_json = ${JSON.stringify(next)}
      WHERE owner_key = ${key} AND reservation_id = ${reservationId}
        AND controller_id = ${controllerId} AND state = ${from}
        AND owner_json = ${current.text} RETURNING owner_key`);
    return rows.length === 1;
  };
  return {
    hasOwnersForThread: async (threadId) => {
      // The journal is capped at MAX_OWNERS. Validate stored bindings before trusting scope;
      // old opaque hashes cannot be assigned to a thread and must fail closed.
      const rows =
        await run(sql<OwnerRow>`SELECT owner_key, reservation_id, controller_id, state, owner_json
        FROM direct_shell_launch_owners`);
      return rows
        .map(decodeRow)
        .some(({ owner }) => !owner.pane || owner.pane.threadId === threadId);
    },
    get: async (key) => (await read(key))?.owner,
    reserve: async (input) => {
      // Decode into a private copy before the first yield; callers cannot mutate intent in flight.
      const owner = parseDirectShellLaunchOwner(input);
      if (owner.state !== "prepared")
        throw new Error("A direct shell reservation must be prepared.");
      const text = JSON.stringify(owner);
      const inserted = await run(sql`INSERT INTO direct_shell_launch_owners
        (owner_key, reservation_id, controller_id, state, owner_json)
        SELECT ${owner.ownerKey}, ${owner.reservationId}, ${owner.controllerId}, 'prepared', ${text}
        WHERE (SELECT COUNT(*) FROM direct_shell_launch_owners) < ${MAX_OWNERS}
        ON CONFLICT(owner_key) DO NOTHING RETURNING owner_key`);
      const saved = await read(owner.ownerKey);
      if (!saved)
        throw new Error("Direct shell owner capacity or persistence prevented reservation.");
      return { created: inserted.length === 1, owner: saved.owner };
    },
    claimDispatch: (key, reservationId, controllerId) =>
      transition(key, reservationId, controllerId, "prepared", "may-have-been-sent"),
    cancelPrepared: async (key, reservationId, controllerId) => {
      const current = await read(key);
      if (
        !current ||
        current.owner.reservationId !== reservationId ||
        current.owner.controllerId !== controllerId ||
        current.owner.state !== "prepared"
      )
        return false;
      const rows = await run(sql`DELETE FROM direct_shell_launch_owners
        WHERE owner_key = ${key} AND reservation_id = ${reservationId}
          AND controller_id = ${controllerId} AND state = 'prepared'
          AND owner_json = ${current.text} RETURNING owner_key`);
      return rows.length === 1;
    },
    confirmTerminated: async (input, control) => {
      // Detach before yielding. Compare the complete stored owner, not just pane/digest:
      // stale confirmations must not terminate or release a replacement reservation.
      const expected = parseDirectShellLaunchOwner(input);
      if (!expected.intent.lifecycle || expected.state === "prepared") return false;
      const current = await read(expected.ownerKey);
      if (!current || JSON.stringify(current.owner) !== JSON.stringify(expected)) return false;
      const frame = await control.closeAndVerify(structuredClone(expected));
      verifyDirectShellTermination(expected, frame);
      // The helper's durable closed admission fences delayed create after this DELETE.
      // An intervening state change refuses release; uncertainty never starts replacement.
      const rows = await run(sql`DELETE FROM direct_shell_launch_owners
        WHERE owner_key = ${expected.ownerKey} AND reservation_id = ${expected.reservationId}
          AND controller_id = ${expected.controllerId} AND state = ${expected.state}
          AND owner_json = ${current.text} RETURNING owner_key`);
      return rows.length === 1;
    },
    markUnknown: (key, reservationId, controllerId) =>
      transition(key, reservationId, controllerId, "may-have-been-sent", "outcome-unknown"),
  } satisfies DirectShellLaunchOwnerStore;
});
