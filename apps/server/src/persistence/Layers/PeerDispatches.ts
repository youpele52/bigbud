import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PeerDispatch } from "@bigbud/contracts/server/remotePeer.ts";

import { applyPeerDispatchEvent } from "../../peer-orchestration/peerDispatch.transition.ts";
import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import {
  PeerDispatchConflict,
  PeerDispatchIllegalTransition,
  PeerDispatchRepository,
  type PeerDispatchRepositoryShape,
} from "../Services/PeerDispatches.ts";

interface Row {
  readonly dispatchId: string;
  readonly commandId: string;
  readonly coordinatorAuthorityId: string;
  readonly coordinatorThreadId: string;
  readonly requestKey: string;
  readonly workerAuthorityId: string;
  readonly grantId: string;
  readonly workspaceRoot: string;
  readonly provider: string;
  readonly permissionsJson: string;
  readonly state: string;
  readonly sendAttempts: number;
  readonly childThreadId: string | null;
  readonly cancelRequestedAt: string | null;
  readonly resultJson: string | null;
  readonly errorJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const columns = (sql: SqlClient.SqlClient) => sql`dispatch_id AS "dispatchId",
  command_id AS "commandId", coordinator_authority_id AS "coordinatorAuthorityId",
  coordinator_thread_id AS "coordinatorThreadId", request_key AS "requestKey",
  worker_authority_id AS "workerAuthorityId", grant_id AS "grantId",
  workspace_root AS "workspaceRoot", provider, permissions_json AS "permissionsJson", state,
  send_attempts AS "sendAttempts", child_thread_id AS "childThreadId",
  cancel_requested_at AS "cancelRequestedAt", result_json AS "resultJson",
  error_json AS "errorJson", created_at AS "createdAt", updated_at AS "updatedAt"`;

const decodeDispatch = Schema.decodeUnknownSync(PeerDispatch);
const parseJson = (value: string | null): unknown => (value === null ? null : JSON.parse(value));

const fromRow = (row: Row): PeerDispatch =>
  decodeDispatch({
    dispatchId: row.dispatchId,
    commandId: row.commandId,
    coordinatorAuthorityId: row.coordinatorAuthorityId,
    coordinatorThreadId: row.coordinatorThreadId,
    requestKey: row.requestKey,
    worker: {
      workerAuthorityId: row.workerAuthorityId,
      grantId: row.grantId,
      workspaceRoot: row.workspaceRoot,
      provider: row.provider,
    },
    permissions: JSON.parse(row.permissionsJson),
    state: row.state,
    sendAttempts: row.sendAttempts,
    childThreadId: row.childThreadId,
    cancelRequestedAt: row.cancelRequestedAt,
    result: parseJson(row.resultJson),
    error: parseJson(row.errorJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const sameTarget = (a: PeerDispatch, b: PeerDispatch): boolean =>
  a.coordinatorAuthorityId === b.coordinatorAuthorityId &&
  a.worker.workerAuthorityId === b.worker.workerAuthorityId &&
  a.worker.grantId === b.worker.grantId &&
  a.worker.workspaceRoot === b.worker.workspaceRoot &&
  a.worker.provider === b.worker.provider;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sqlError = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`PeerDispatchRepository.${operation}`));
  const decodeAll = (rows: ReadonlyArray<Row>) =>
    Effect.try({
      try: () => rows.map(fromRow),
      catch: toPersistenceDecodeCauseError("PeerDispatchRepository.decode"),
    });
  const first = (rows: ReadonlyArray<Row>) =>
    decodeAll(rows.slice(0, 1)).pipe(Effect.map((all) => all[0]));

  const get: PeerDispatchRepositoryShape["get"] = (dispatchId) =>
    sql<Row>`SELECT ${columns(sql)} FROM peer_dispatches WHERE dispatch_id = ${dispatchId}`.pipe(
      sqlError("get"),
      Effect.flatMap(first),
    );
  const findByRequestKey: PeerDispatchRepositoryShape["findByRequestKey"] = (threadId, key) =>
    sql<Row>`SELECT ${columns(sql)} FROM peer_dispatches
      WHERE coordinator_thread_id = ${threadId} AND request_key = ${key}`.pipe(
      sqlError("findByRequestKey"),
      Effect.flatMap(first),
    );

  const insert: PeerDispatchRepositoryShape["insert"] = Effect.fn("PeerDispatchRepository.insert")(
    function* (input) {
      const d = yield* Effect.try({
        try: () => decodeDispatch(input),
        catch: toPersistenceDecodeCauseError("PeerDispatchRepository.insert"),
      });
      if (
        d.state !== "pending" ||
        d.sendAttempts !== 0 ||
        d.childThreadId !== null ||
        d.cancelRequestedAt !== null ||
        d.result !== null ||
        d.error !== null
      )
        return yield* new PeerDispatchConflict({ detail: "A new dispatch must start pending." });
      const created = yield* sql<{ dispatchId: string }>`INSERT INTO peer_dispatches (
          dispatch_id, command_id, coordinator_authority_id, coordinator_thread_id, request_key,
          worker_authority_id, grant_id, workspace_root, provider, permissions_json, state,
          send_attempts, created_at, updated_at
        ) VALUES (${d.dispatchId}, ${d.commandId}, ${d.coordinatorAuthorityId},
          ${d.coordinatorThreadId}, ${d.requestKey}, ${d.worker.workerAuthorityId},
          ${d.worker.grantId}, ${d.worker.workspaceRoot}, ${d.worker.provider},
          ${JSON.stringify(d.permissions)}, 'pending', 0, ${d.createdAt}, ${d.updatedAt})
        ON CONFLICT DO NOTHING
        RETURNING dispatch_id AS "dispatchId"`.pipe(sqlError("insert"));
      if (created.length > 0) {
        const stored = yield* get(d.dispatchId);
        if (stored) return { dispatch: stored, joined: false };
      }
      const existing = yield* findByRequestKey(d.coordinatorThreadId, d.requestKey);
      if (existing && sameTarget(existing, d)) return { dispatch: existing, joined: true };
      return yield* new PeerDispatchConflict({
        detail: existing
          ? "This request key already dispatched to a different worker target."
          : "The dispatch id or command id belongs to a different request.",
      });
    },
  );

  const transition: PeerDispatchRepositoryShape["transition"] = Effect.fn(
    "PeerDispatchRepository.transition",
  )(function* (dispatchId, event, patch) {
    const current = yield* get(dispatchId);
    if (!current)
      return yield* new PeerDispatchIllegalTransition({ dispatchId, from: null, event });
    const step = applyPeerDispatchEvent(current.state, event);
    if (step._tag === "illegal")
      return yield* new PeerDispatchIllegalTransition({ dispatchId, from: current.state, event });
    const missing =
      (event === "worker-accepted" && !patch.childThreadId && !current.childThreadId) ||
      (event === "child-completed" && patch.result?.outcome !== "completed") ||
      ((event === "child-failed" || event === "rejected") && !patch.error);
    if (missing)
      return yield* new PeerDispatchConflict({ detail: `Event ${event} is missing its record.` });
    const cancelling = step.to === "cancel-pending" || step.to === "cancelled";
    const rows = yield* sql<{ dispatchId: string }>`UPDATE peer_dispatches SET
        state = ${step.to}, updated_at = ${patch.updatedAt},
        send_attempts = send_attempts + ${event === "send-started" ? 1 : 0},
        child_thread_id = COALESCE(child_thread_id, ${patch.childThreadId ?? null}),
        cancel_requested_at = ${
          cancelling
            ? sql`COALESCE(cancel_requested_at, ${patch.updatedAt})`
            : sql`cancel_requested_at`
        },
        result_json = COALESCE(${patch.result ? JSON.stringify(patch.result) : null}, result_json),
        error_json = COALESCE(${patch.error ? JSON.stringify(patch.error) : null}, error_json)
      WHERE dispatch_id = ${dispatchId} AND state = ${current.state}
      RETURNING dispatch_id AS "dispatchId"`.pipe(sqlError("transition"));
    return rows.length === 0 ? undefined : yield* get(dispatchId);
  });

  return {
    insert,
    get,
    findByRequestKey,
    listUnsettled: (limit) =>
      sql<Row>`SELECT ${columns(sql)} FROM peer_dispatches
        WHERE state NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY updated_at ASC, rowid ASC LIMIT ${Math.max(0, Math.floor(limit))}`.pipe(
        sqlError("listUnsettled"),
        Effect.flatMap(decodeAll),
      ),
    transition,
    recordSendRetry: Effect.fn("PeerDispatchRepository.recordSendRetry")(
      function* (dispatchId, updatedAt) {
        const rows = yield* sql<{ dispatchId: string }>`UPDATE peer_dispatches
          SET send_attempts = send_attempts + 1, updated_at = ${updatedAt}
          WHERE dispatch_id = ${dispatchId} AND state = 'sent-uncertain'
          RETURNING dispatch_id AS "dispatchId"`.pipe(sqlError("recordSendRetry"));
        return rows.length === 0 ? undefined : yield* get(dispatchId);
      },
    ),
  } satisfies PeerDispatchRepositoryShape;
});

export const PeerDispatchRepositoryLive = Layer.effect(PeerDispatchRepository, make);
