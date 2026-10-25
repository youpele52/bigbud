import type { MessageId, ProviderKind, ThreadId, TurnId } from "@bigbud/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ThreadRecoveryIntentRepository,
  type ThreadRecoveryDetail,
  type ThreadRecoveryIntent,
  type ThreadRecoveryIntentRepositoryShape,
} from "../Services/ThreadRecoveryIntents.ts";

interface IntentRow {
  readonly threadId: string;
  readonly messageId: string;
  readonly provider: string | null;
  readonly turnId: string | null;
  readonly disposition: ThreadRecoveryIntent["disposition"];
  readonly recoveryStatus: ThreadRecoveryIntent["recoveryStatus"];
  readonly detailJson: string;
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  readonly continuationMessageId: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const DEFAULT_LIST_LIMIT = 200;

function parseDetail(json: string): ThreadRecoveryDetail {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" ? (parsed as ThreadRecoveryDetail) : {};
  } catch {
    return {};
  }
}

function toIntent(row: IntentRow): ThreadRecoveryIntent {
  return {
    threadId: row.threadId as ThreadId,
    messageId: row.messageId as MessageId,
    provider: row.provider as ProviderKind | null,
    turnId: row.turnId as TurnId | null,
    disposition: row.disposition,
    recoveryStatus: row.recoveryStatus,
    detail: parseDetail(row.detailJson),
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt,
    continuationMessageId: row.continuationMessageId as MessageId | null,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`thread_id AS "threadId", message_id AS "messageId", provider,
    turn_id AS "turnId", disposition, recovery_status AS "recoveryStatus",
    recovery_detail_json AS "detailJson", attempt_count AS "attemptCount",
    last_attempt_at AS "lastAttemptAt", continuation_message_id AS "continuationMessageId",
    revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
  const fail = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`ThreadRecoveryIntents.${operation}`));

  const recordAccepted: ThreadRecoveryIntentRepositoryShape["recordAccepted"] = (input) =>
    sql`INSERT INTO thread_recovery_intents (
        thread_id, message_id, provider, disposition, recovery_status, recovery_detail_json,
        attempt_count, revision, created_at, updated_at
      ) VALUES (
        ${input.threadId}, ${input.messageId}, ${input.provider}, 'active', 'none',
        ${JSON.stringify(input.detail ?? {})}, ${input.attemptCount ?? 0}, 0,
        ${input.createdAt}, ${input.createdAt}
      ) ON CONFLICT (thread_id, message_id) DO NOTHING`.pipe(Effect.asVoid, fail("recordAccepted"));

  const settleSupersededByTurnStart: ThreadRecoveryIntentRepositoryShape["settleSupersededByTurnStart"] =
    (input) =>
      sql`UPDATE thread_recovery_intents
        SET disposition = 'settled', revision = revision + 1, updated_at = ${input.at}
        WHERE thread_id = ${input.threadId} AND message_id != ${input.messageId}
          AND disposition = 'active'
          AND (continuation_message_id IS NULL OR continuation_message_id != ${input.messageId})`.pipe(
        Effect.asVoid,
        fail("settleSupersededByTurnStart"),
      );

  const settleRecoveringForThread: ThreadRecoveryIntentRepositoryShape["settleRecoveringForThread"] =
    (input) =>
      sql`UPDATE thread_recovery_intents
        SET disposition = 'settled', revision = revision + 1, updated_at = ${input.at}
        WHERE thread_id = ${input.threadId} AND disposition = 'active'
          AND recovery_status != 'none'`.pipe(Effect.asVoid, fail("settleRecoveringForThread"));

  const revokeForThread: ThreadRecoveryIntentRepositoryShape["revokeForThread"] = (input) =>
    sql`UPDATE thread_recovery_intents
      SET disposition = 'revoked', revision = revision + 1, updated_at = ${input.at}
      WHERE thread_id = ${input.threadId}
        AND disposition IN ('active', 'suspended-for-exit')`.pipe(
      Effect.asVoid,
      fail("revokeForThread"),
    );

  const suspendActiveForExit: ThreadRecoveryIntentRepositoryShape["suspendActiveForExit"] = (
    input,
  ) =>
    sql<{ threadId: string }>`UPDATE thread_recovery_intents
      SET disposition = 'suspended-for-exit', revision = revision + 1, updated_at = ${input.at}
      WHERE disposition = 'active'
      RETURNING thread_id AS "threadId"`.pipe(
      Effect.map((rows) => rows.length),
      fail("suspendActiveForExit"),
    );

  const get: ThreadRecoveryIntentRepositoryShape["get"] = (key) =>
    sql<IntentRow>`SELECT ${columns} FROM thread_recovery_intents
      WHERE thread_id = ${key.threadId} AND message_id = ${key.messageId}`.pipe(
      Effect.map((rows) => Option.fromUndefinedOr(rows[0]).pipe(Option.map(toIntent))),
      fail("get"),
    );

  const listActive: ThreadRecoveryIntentRepositoryShape["listActive"] = (input) => {
    const statuses = input?.statuses;
    const limit = input?.limit ?? DEFAULT_LIST_LIMIT;
    const after = input?.after;
    const statusFilter =
      statuses === undefined
        ? sql``
        : statuses.length === 0
          ? sql`AND 0`
          : sql`AND ${sql.in("recovery_status", statuses)}`;
    const afterFilter =
      after === undefined
        ? sql``
        : sql`AND (updated_at, thread_id, message_id) > (${after.at}, ${after.threadId}, ${after.messageId})`;
    return sql<IntentRow>`SELECT ${columns} FROM thread_recovery_intents
      WHERE disposition = 'active' ${statusFilter} ${afterFilter}
      ORDER BY updated_at ASC, thread_id ASC, message_id ASC
      LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map(toIntent)),
      fail("listActive"),
    );
  };

  const listAwaitingProviderActivity: ThreadRecoveryIntentRepositoryShape["listAwaitingProviderActivity"] =
    (input) =>
      sql<IntentRow>`SELECT ${columns} FROM thread_recovery_intents
        WHERE disposition = 'active' AND recovery_status = 'awaiting-user'
          AND json_extract(recovery_detail_json, '$.reason') = 'no-activity-after-wake'
        ORDER BY updated_at DESC, thread_id DESC, message_id DESC
        LIMIT ${input.limit}`.pipe(
        Effect.map((rows) => rows.map(toIntent)),
        fail("listAwaitingProviderActivity"),
      );

  const latestOpenForThread: ThreadRecoveryIntentRepositoryShape["latestOpenForThread"] = (
    threadId,
  ) =>
    sql<IntentRow>`SELECT ${columns} FROM thread_recovery_intents
      WHERE thread_id = ${threadId} AND disposition IN ('active', 'suspended-for-exit')
      ORDER BY created_at DESC, message_id DESC LIMIT 1`.pipe(
      Effect.map((rows) => Option.fromUndefinedOr(rows[0]).pipe(Option.map(toIntent))),
      fail("latestOpenForThread"),
    );

  const listUncertainAfterRestart: ThreadRecoveryIntentRepositoryShape["listUncertainAfterRestart"] =
    (input) =>
      sql<IntentRow>`SELECT ${columns} FROM thread_recovery_intents i
        WHERE i.disposition IN ('active', 'suspended-for-exit')
          ${
            input?.after === undefined
              ? sql``
              : sql`AND (i.created_at, i.thread_id, i.message_id) > (${input.after.at}, ${input.after.threadId}, ${input.after.messageId})`
          }
          AND EXISTS (
            SELECT 1 FROM provider_dispatch_attempts a
            WHERE a.thread_id = i.thread_id AND a.message_id = i.message_id
              AND a.state IN ('may-have-been-sent', 'provider-acknowledged')
              AND a.prepared_at = (
                SELECT MAX(latest.prepared_at) FROM provider_dispatch_attempts latest
                WHERE latest.thread_id = i.thread_id AND latest.message_id = i.message_id
              )
          )
        ORDER BY i.created_at ASC, i.thread_id ASC, i.message_id ASC
        LIMIT ${input?.limit ?? DEFAULT_LIST_LIMIT}`.pipe(
        Effect.map((rows) => rows.map(toIntent)),
        fail("listUncertainAfterRestart"),
      );

  const transition: ThreadRecoveryIntentRepositoryShape["transition"] = (input) => {
    const { patch } = input;
    const sets = [
      patch.disposition !== undefined ? sql`disposition = ${patch.disposition}` : null,
      patch.recoveryStatus !== undefined ? sql`recovery_status = ${patch.recoveryStatus}` : null,
      patch.detail !== undefined
        ? sql`recovery_detail_json = ${JSON.stringify(patch.detail)}`
        : null,
      patch.attemptCount !== undefined ? sql`attempt_count = ${patch.attemptCount}` : null,
      patch.lastAttemptAt !== undefined ? sql`last_attempt_at = ${patch.lastAttemptAt}` : null,
      patch.continuationMessageId !== undefined
        ? sql`continuation_message_id = ${patch.continuationMessageId}`
        : null,
      sql`revision = revision + 1`,
      sql`updated_at = ${input.at}`,
    ].filter((entry) => entry !== null);
    return sql<{ revision: number }>`UPDATE thread_recovery_intents
      SET ${sql.csv(sets)}
      WHERE thread_id = ${input.key.threadId} AND message_id = ${input.key.messageId}
        AND revision = ${input.expectedRevision}
      RETURNING revision`.pipe(
      Effect.map((rows) => rows.length === 1),
      fail("transition"),
    );
  };

  const hasUncertainRemoteShell: ThreadRecoveryIntentRepositoryShape["hasUncertainRemoteShell"] = (
    threadId,
  ) =>
    sql<{ found: number }>`SELECT 1 AS found FROM remote_agent_runtime_owners
      WHERE owner_key = ${`shell:${threadId}`}
        AND json_extract(route_json, '$.state') IN ('may-have-been-sent', 'outcome-unknown')
      LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
      fail("hasUncertainRemoteShell"),
    );

  const pruneResolved: ThreadRecoveryIntentRepositoryShape["pruneResolved"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM provider_dispatch_attempts
            WHERE (thread_id, message_id) IN (
              SELECT thread_id, message_id FROM thread_recovery_intents
              WHERE disposition IN ('settled', 'revoked') AND updated_at < ${input.before}
            )`;
          yield* sql`DELETE FROM thread_recovery_intents
            WHERE disposition IN ('settled', 'revoked') AND updated_at < ${input.before}`;
        }),
      )
      .pipe(Effect.asVoid, fail("pruneResolved"));

  return {
    recordAccepted,
    settleSupersededByTurnStart,
    settleRecoveringForThread,
    revokeForThread,
    suspendActiveForExit,
    get,
    listActive,
    listAwaitingProviderActivity,
    latestOpenForThread,
    listUncertainAfterRestart,
    hasUncertainRemoteShell,
    transition,
    pruneResolved,
  } satisfies ThreadRecoveryIntentRepositoryShape;
});

export const ThreadRecoveryIntentRepositoryLive = Layer.effect(
  ThreadRecoveryIntentRepository,
  make,
);
