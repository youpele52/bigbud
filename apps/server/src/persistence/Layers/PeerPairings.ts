import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PeerPairing } from "@bigbud/contracts/server/remotePeer.pairing.ts";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import {
  PeerPairingConflict,
  PeerPairingRepository,
  type PeerPairingRepositoryShape,
} from "../Services/PeerPairings.ts";

const columns = (sql: SqlClient.SqlClient) => sql`pairing_id AS "pairingId", label,
  worker_authority_id AS "workerAuthorityId", host, port, ssh_user AS "user",
  pinned_host_key AS "pinnedHostKey", host_key_fingerprint AS "hostKeyFingerprint",
  host_key_confirmed_at AS "hostKeyConfirmedAt", workspace_root AS "workspaceRoot", provider,
  runtime_mode AS "runtimeMode", coordinator_key_fingerprint AS "coordinatorKeyFingerprint",
  grant_id AS "grantId", grant_recorded_at AS "grantRecordedAt",
  grant_revoked_at AS "grantRevokedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

const decodePairing = Schema.decodeUnknownSync(PeerPairing);

/** Fields a grant is bound to; changing them under an active grant would desynchronize it. */
const grantBound = (pairing: PeerPairing) =>
  JSON.stringify([
    pairing.workspaceRoot,
    pairing.provider,
    pairing.runtimeMode,
    pairing.coordinatorKeyFingerprint,
  ]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sqlError = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`PeerPairingRepository.${operation}`));
  const decodeAll = (rows: ReadonlyArray<unknown>) =>
    Effect.try({
      try: () => rows.map((row) => decodePairing(row)),
      catch: toPersistenceDecodeCauseError("PeerPairingRepository.decode"),
    });
  const first = (rows: ReadonlyArray<unknown>) =>
    decodeAll(rows.slice(0, 1)).pipe(Effect.map((all) => all[0]));

  const get: PeerPairingRepositoryShape["get"] = (pairingId) =>
    sql`SELECT ${columns(sql)} FROM peer_pairings WHERE pairing_id = ${pairingId}`.pipe(
      sqlError("get"),
      Effect.flatMap(first),
    );
  const findByWorker: PeerPairingRepositoryShape["findByWorker"] = (workerAuthorityId) =>
    sql`SELECT ${columns(sql)} FROM peer_pairings
      WHERE worker_authority_id = ${workerAuthorityId}`.pipe(
      sqlError("findByWorker"),
      Effect.flatMap(first),
    );

  const save: PeerPairingRepositoryShape["save"] = Effect.fn("PeerPairingRepository.save")(
    function* ({ connection: c, at }) {
      const candidate = yield* Effect.try({
        try: () =>
          decodePairing({
            ...c,
            grantId: null,
            grantRecordedAt: null,
            grantRevokedAt: null,
            createdAt: at,
            updatedAt: at,
          }),
        catch: toPersistenceDecodeCauseError("PeerPairingRepository.save"),
      });
      const existing = yield* findByWorker(c.workerAuthorityId);
      if (!existing) {
        yield* sql`INSERT INTO peer_pairings (pairing_id, label, worker_authority_id, host, port,
            ssh_user, pinned_host_key, host_key_fingerprint, host_key_confirmed_at,
            workspace_root, provider, runtime_mode, coordinator_key_fingerprint, created_at,
            updated_at)
          VALUES (${c.pairingId}, ${c.label}, ${c.workerAuthorityId}, ${c.host}, ${c.port},
            ${c.user}, ${c.pinnedHostKey}, ${c.hostKeyFingerprint}, ${c.hostKeyConfirmedAt},
            ${c.workspaceRoot}, ${c.provider}, ${c.runtimeMode}, ${c.coordinatorKeyFingerprint},
            ${at}, ${at})`.pipe(sqlError("save"));
        return (yield* get(c.pairingId)) ?? candidate;
      }
      const activeGrant = existing.grantId !== null && existing.grantRevokedAt === null;
      if (activeGrant && grantBound(existing) !== grantBound(candidate))
        return yield* new PeerPairingConflict({
          detail: "Revoke the active grant before changing the workspace, provider, mode or key.",
        });
      yield* sql`UPDATE peer_pairings SET label = ${c.label}, host = ${c.host}, port = ${c.port},
          ssh_user = ${c.user}, pinned_host_key = ${c.pinnedHostKey},
          host_key_fingerprint = ${c.hostKeyFingerprint},
          host_key_confirmed_at = ${c.hostKeyConfirmedAt}, workspace_root = ${c.workspaceRoot},
          provider = ${c.provider}, runtime_mode = ${c.runtimeMode},
          coordinator_key_fingerprint = ${c.coordinatorKeyFingerprint}, updated_at = ${at}
        WHERE pairing_id = ${existing.pairingId}`.pipe(sqlError("save"));
      return (yield* get(existing.pairingId)) ?? existing;
    },
  );

  return {
    save,
    get,
    findByWorker,
    list: () =>
      sql`SELECT ${columns(sql)} FROM peer_pairings ORDER BY created_at ASC, rowid ASC
        LIMIT 64`.pipe(sqlError("list"), Effect.flatMap(decodeAll)),
    recordGrant: (pairingId, grantId, at) =>
      sql`UPDATE peer_pairings SET grant_id = ${grantId}, grant_recorded_at = ${at},
          grant_revoked_at = NULL, updated_at = ${at}
        WHERE pairing_id = ${pairingId}`.pipe(
        sqlError("recordGrant"),
        Effect.andThen(get(pairingId)),
      ),
    revoke: (pairingId, at) =>
      sql`UPDATE peer_pairings SET grant_revoked_at = COALESCE(grant_revoked_at, ${at}),
          updated_at = ${at}
        WHERE pairing_id = ${pairingId} AND grant_id IS NOT NULL`.pipe(
        sqlError("revoke"),
        Effect.andThen(get(pairingId)),
      ),
    remove: (pairingId) =>
      sql<{ pairingId: string }>`DELETE FROM peer_pairings WHERE pairing_id = ${pairingId}
        RETURNING pairing_id AS "pairingId"`.pipe(
        sqlError("remove"),
        Effect.map((rows) => rows.length > 0),
      ),
  } satisfies PeerPairingRepositoryShape;
});

export const PeerPairingRepositoryLive = Layer.effect(PeerPairingRepository, make);
