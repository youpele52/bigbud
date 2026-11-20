import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  PeerChildConflict,
  PeerChildRepository,
  PeerChildStart,
  type PeerChild,
  type PeerChildRepositoryShape,
} from "../Services/PeerChildren.ts";

const START_FAILURE_MAX_CHARS = 1024;

const columns = (sql: SqlClient.SqlClient) => sql`command_id AS "commandId",
  dispatch_id AS "dispatchId", coordinator_authority_id AS "coordinatorAuthorityId",
  grant_id AS "grantId", child_thread_id AS "childThreadId", request_digest AS "requestDigest",
  workspace_root AS "workspaceRoot", provider, created_at AS "createdAt",
  cancel_requested_at AS "cancelRequestedAt", start_json AS "startJson",
  start_completed_at AS "startCompletedAt", start_failure AS "startFailure"`;

type PeerChildRow = Omit<PeerChild, "start"> & { readonly startJson: string | null };

const decodeStart = Schema.decodeUnknownEffect(Schema.fromJsonString(PeerChildStart));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sqlError = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`PeerChildRepository.${operation}`));
  const toChild = ({ startJson, ...row }: PeerChildRow) =>
    startJson === null
      ? Effect.succeed<PeerChild>({ ...row, start: null })
      : decodeStart(startJson).pipe(
          Effect.map((start): PeerChild => ({ ...row, start })),
          Effect.mapError(toPersistenceDecodeError("PeerChildRepository.start")),
        );
  const rows = <E>(operation: string, query: Effect.Effect<ReadonlyArray<PeerChildRow>, E>) =>
    query.pipe(
      Effect.mapError(toPersistenceSqlError(`PeerChildRepository.${operation}`)),
      Effect.flatMap((found) => Effect.forEach(found, toChild)),
    );
  const byCommand = (commandId: string) =>
    rows(
      "byCommand",
      sql<PeerChildRow>`SELECT ${columns(sql)} FROM peer_children WHERE command_id = ${commandId}`,
    );

  const findByCommand: PeerChildRepositoryShape["findByCommand"] = (commandId) =>
    byCommand(commandId).pipe(Effect.map((found) => found[0]));

  const findForGrant: PeerChildRepositoryShape["findForGrant"] = (grantId, commandId) =>
    byCommand(commandId).pipe(Effect.map((found) => found.find((row) => row.grantId === grantId)));

  const claim: PeerChildRepositoryShape["claim"] = Effect.fn("PeerChildRepository.claim")(
    function* (child) {
      const startJson = child.start === null ? null : JSON.stringify(child.start);
      const inserted = yield* sql`INSERT INTO peer_children (command_id, dispatch_id,
          coordinator_authority_id, grant_id, child_thread_id, request_digest, workspace_root,
          provider, created_at, cancel_requested_at, start_json)
        VALUES (${child.commandId}, ${child.dispatchId}, ${child.coordinatorAuthorityId},
          ${child.grantId}, ${child.childThreadId}, ${child.requestDigest}, ${child.workspaceRoot},
          ${child.provider}, ${child.createdAt}, NULL, ${startJson})
        ON CONFLICT(command_id) DO NOTHING
        RETURNING command_id AS "commandId"`.pipe(sqlError("claim"));
      const [stored] = yield* byCommand(child.commandId);
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
    findByCommand,
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
    listIncompleteStarts: (limit) =>
      rows(
        "listIncompleteStarts",
        sql<PeerChildRow>`SELECT ${columns(sql)} FROM peer_children
          WHERE start_json IS NOT NULL AND start_completed_at IS NULL AND start_failure IS NULL
          ORDER BY created_at ASC, command_id ASC LIMIT ${limit}`,
      ),
    settleStart: (commandId, outcome) =>
      ("completedAt" in outcome
        ? sql`UPDATE peer_children SET start_completed_at = ${outcome.completedAt}
            WHERE command_id = ${commandId}
              AND start_completed_at IS NULL AND start_failure IS NULL`
        : sql`UPDATE peer_children
            SET start_failure = ${outcome.failure.slice(0, START_FAILURE_MAX_CHARS)}
            WHERE command_id = ${commandId}
              AND start_completed_at IS NULL AND start_failure IS NULL`
      ).pipe(sqlError("settleStart"), Effect.asVoid),
  } satisfies PeerChildRepositoryShape;
});

export const PeerChildRepositoryLive = Layer.effect(PeerChildRepository, make);
