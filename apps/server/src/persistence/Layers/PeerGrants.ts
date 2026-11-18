import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PeerGrant } from "@bigbud/contracts/server/remotePeer.ts";

import { findPeerPermissionViolations } from "../../peer-orchestration/peerPermission.narrowing.ts";
import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import {
  PeerGrantExceedsCeiling,
  PeerGrantRepository,
  type PeerGrantRepositoryShape,
} from "../Services/PeerGrants.ts";

interface Row {
  readonly grantId: string;
  readonly coordinatorAuthorityId: string;
  readonly coordinatorKeyFingerprint: string;
  readonly workerAuthorityId: string;
  readonly actionsJson: string;
  readonly ceilingJson: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

const columns = (sql: SqlClient.SqlClient) => sql`grant_id AS "grantId",
  coordinator_authority_id AS "coordinatorAuthorityId",
  coordinator_key_fingerprint AS "coordinatorKeyFingerprint",
  worker_authority_id AS "workerAuthorityId", actions_json AS "actionsJson",
  ceiling_json AS "ceilingJson", issued_at AS "issuedAt", expires_at AS "expiresAt",
  revoked_at AS "revokedAt"`;

const decodeGrant = Schema.decodeUnknownSync(PeerGrant);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decode = (row: Row) =>
    Effect.try({
      try: () =>
        decodeGrant({
          grantId: row.grantId,
          coordinatorAuthorityId: row.coordinatorAuthorityId,
          coordinatorKeyFingerprint: row.coordinatorKeyFingerprint,
          workerAuthorityId: row.workerAuthorityId,
          actions: JSON.parse(row.actionsJson),
          ceiling: JSON.parse(row.ceilingJson),
          issuedAt: row.issuedAt,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
        }),
      catch: toPersistenceDecodeCauseError("PeerGrantRepository.decode"),
    });
  const first = (rows: ReadonlyArray<Row>) => (rows[0] ? decode(rows[0]) : Effect.undefined);
  const sqlError = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`PeerGrantRepository.${operation}`));

  const get: PeerGrantRepositoryShape["get"] = (grantId) =>
    sql<Row>`SELECT ${columns(sql)} FROM peer_grants WHERE grant_id = ${grantId}`.pipe(
      sqlError("get"),
      Effect.flatMap(first),
    );

  const issue: PeerGrantRepositoryShape["issue"] = Effect.fn("PeerGrantRepository.issue")(
    function* ({ grant: input, localCeiling }) {
      const grant = yield* Effect.try({
        try: () => decodeGrant(input),
        catch: toPersistenceDecodeCauseError("PeerGrantRepository.issue"),
      });
      const violations = findPeerPermissionViolations(grant.ceiling, localCeiling);
      if (violations.length > 0)
        return yield* new PeerGrantExceedsCeiling({
          detail: `Grant exceeds the worker ceiling: ${violations.map((v) => v.kind).join(", ")}.`,
        });
      if (grant.revokedAt !== null)
        return yield* new PeerGrantExceedsCeiling({ detail: "A new grant must be unrevoked." });
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE peer_grants SET revoked_at = ${grant.issuedAt}
              WHERE coordinator_authority_id = ${grant.coordinatorAuthorityId}
                AND revoked_at IS NULL AND grant_id <> ${grant.grantId}`;
            yield* sql`INSERT INTO peer_grants (grant_id, coordinator_authority_id,
                coordinator_key_fingerprint, worker_authority_id, actions_json, ceiling_json,
                issued_at, expires_at, revoked_at)
              VALUES (${grant.grantId}, ${grant.coordinatorAuthorityId},
                ${grant.coordinatorKeyFingerprint}, ${grant.workerAuthorityId},
                ${JSON.stringify(grant.actions)}, ${JSON.stringify(grant.ceiling)},
                ${grant.issuedAt}, ${grant.expiresAt}, NULL)`;
          }),
        )
        .pipe(sqlError("issue"));
      const stored = yield* get(grant.grantId);
      if (!stored)
        return yield* new PeerGrantExceedsCeiling({ detail: "The issued grant was not stored." });
      return stored;
    },
  );

  return {
    issue,
    get,
    findActiveForCoordinator: (coordinatorAuthorityId) =>
      sql<Row>`SELECT ${columns(sql)} FROM peer_grants
        WHERE coordinator_authority_id = ${coordinatorAuthorityId} AND revoked_at IS NULL`.pipe(
        sqlError("findActiveForCoordinator"),
        Effect.flatMap(first),
      ),
    revoke: Effect.fn("PeerGrantRepository.revoke")(function* (grantId, revokedAt) {
      yield* sql`UPDATE peer_grants SET revoked_at = ${revokedAt}
        WHERE grant_id = ${grantId} AND revoked_at IS NULL`.pipe(sqlError("revoke"));
      return yield* get(grantId);
    }),
  } satisfies PeerGrantRepositoryShape;
});

export const PeerGrantRepositoryLive = Layer.effect(PeerGrantRepository, make);
