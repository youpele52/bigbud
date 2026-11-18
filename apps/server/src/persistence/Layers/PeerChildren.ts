import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  PeerChildConflict,
  PeerChildRepository,
  type PeerChild,
  type PeerChildRepositoryShape,
} from "../Services/PeerChildren.ts";

const columns = (sql: SqlClient.SqlClient) => sql`command_id AS "commandId",
  dispatch_id AS "dispatchId", coordinator_authority_id AS "coordinatorAuthorityId",
  grant_id AS "grantId", child_thread_id AS "childThreadId", request_digest AS "requestDigest",
  workspace_root AS "workspaceRoot", provider, created_at AS "createdAt",
  cancel_requested_at AS "cancelRequestedAt"`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sqlError = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`PeerChildRepository.${operation}`));
  const byCommand = (commandId: string) =>
    sql<PeerChild>`SELECT ${columns(sql)} FROM peer_children WHERE command_id = ${commandId}`;

  const findForGrant: PeerChildRepositoryShape["findForGrant"] = (grantId, commandId) =>
    byCommand(commandId).pipe(
      sqlError("findForGrant"),
      Effect.map((rows) => rows.find((row) => row.grantId === grantId)),
    );

  const claim: PeerChildRepositoryShape["claim"] = Effect.fn("PeerChildRepository.claim")(
    function* (child) {
      const inserted = yield* sql`INSERT INTO peer_children (command_id, dispatch_id,
          coordinator_authority_id, grant_id, child_thread_id, request_digest, workspace_root,
          provider, created_at, cancel_requested_at)
        VALUES (${child.commandId}, ${child.dispatchId}, ${child.coordinatorAuthorityId},
          ${child.grantId}, ${child.childThreadId}, ${child.requestDigest}, ${child.workspaceRoot},
          ${child.provider}, ${child.createdAt}, NULL)
        ON CONFLICT(command_id) DO NOTHING
        RETURNING command_id AS "commandId"`.pipe(sqlError("claim"));
      const [stored] = yield* byCommand(child.commandId).pipe(sqlError("claim"));
      if (!stored)
        return yield* new PeerChildConflict({
          commandId: child.commandId,
          detail: "The dispatch record was not stored.",
        });
      if (stored.grantId !== child.grantId || stored.requestDigest !== child.requestDigest)
        return yield* new PeerChildConflict({
          commandId: child.commandId,
          detail: "This dispatch identity was already used for a different request or grant.",
        });
      return { child: stored, joined: inserted.length === 0 };
    },
  );

  return {
    claim,
    findForGrant,
    markCancelRequested: Effect.fn("PeerChildRepository.markCancelRequested")(
      function* (grantId, commandId, at) {
        yield* sql`UPDATE peer_children
          SET cancel_requested_at = COALESCE(cancel_requested_at, ${at})
          WHERE command_id = ${commandId} AND grant_id = ${grantId}`.pipe(
          sqlError("markCancelRequested"),
        );
        return yield* findForGrant(grantId, commandId);
      },
    ),
  } satisfies PeerChildRepositoryShape;
});

export const PeerChildRepositoryLive = Layer.effect(PeerChildRepository, make);
