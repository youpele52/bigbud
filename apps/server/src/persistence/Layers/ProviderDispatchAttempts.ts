import { randomUUID } from "node:crypto";

import type { MessageId, ProviderKind, ThreadId, TurnId } from "@bigbud/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProviderDispatchAttemptRepository,
  type ProviderDispatchAttempt,
  type ProviderDispatchAttemptRepositoryShape,
} from "../Services/ProviderDispatchAttempts.ts";

interface AttemptRow {
  readonly attemptId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly intentRevision: number;
  readonly payloadDigest: string;
  readonly provider: string | null;
  readonly turnId: string | null;
  readonly state: ProviderDispatchAttempt["state"];
  readonly preparedAt: string;
  readonly mayHaveBeenSentAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly updatedAt: string;
}

function toAttempt(row: AttemptRow): ProviderDispatchAttempt {
  return {
    ...row,
    threadId: row.threadId as ThreadId,
    messageId: row.messageId as MessageId,
    provider: row.provider as ProviderKind | null,
    turnId: row.turnId as TurnId | null,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`attempt_id AS "attemptId", thread_id AS "threadId",
    message_id AS "messageId", intent_revision AS "intentRevision",
    payload_digest AS "payloadDigest", provider, turn_id AS "turnId", state,
    prepared_at AS "preparedAt", may_have_been_sent_at AS "mayHaveBeenSentAt",
    acknowledged_at AS "acknowledgedAt", updated_at AS "updatedAt"`;
  const fail = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`ProviderDispatchAttempts.${operation}`));

  const readAttempt = (attemptId: string) =>
    sql<AttemptRow>`SELECT ${columns} FROM provider_dispatch_attempts
      WHERE attempt_id = ${attemptId}`.pipe(
      Effect.map((rows) => Option.fromUndefinedOr(rows[0]).pipe(Option.map(toAttempt))),
    );

  /** Claims `prepared`: reuses the intent's open attempt, or inserts one. */
  const claimPrepared = (
    input: Parameters<ProviderDispatchAttemptRepositoryShape["markMayHaveBeenSent"]>[0],
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const intents = yield* sql<{ revision: number }>`SELECT revision
          FROM thread_recovery_intents
          WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
            AND disposition = 'active'`;
        const intent = intents[0];
        if (intent === undefined) return Option.none<string>();
        const open = yield* sql<{ attemptId: string }>`SELECT attempt_id AS "attemptId"
          FROM provider_dispatch_attempts
          WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
            AND state != 'provider-acknowledged'`;
        const existing = open[0]?.attemptId;
        if (existing !== undefined) {
          yield* sql`UPDATE provider_dispatch_attempts
            SET state = 'prepared', intent_revision = ${intent.revision},
              payload_digest = ${input.payloadDigest}, provider = ${input.provider},
              prepared_at = ${input.at}, updated_at = ${input.at}
            WHERE attempt_id = ${existing}`;
          return Option.some(existing);
        }
        const attemptId = randomUUID();
        yield* sql`INSERT INTO provider_dispatch_attempts (
            attempt_id, thread_id, message_id, intent_revision, payload_digest, provider,
            state, prepared_at, updated_at
          ) VALUES (
            ${attemptId}, ${input.threadId}, ${input.messageId}, ${intent.revision},
            ${input.payloadDigest}, ${input.provider}, 'prepared', ${input.at}, ${input.at}
          )`;
        return Option.some(attemptId);
      }),
    );

  const markMayHaveBeenSent: ProviderDispatchAttemptRepositoryShape["markMayHaveBeenSent"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const claimed = yield* claimPrepared(input);
      if (Option.isNone(claimed)) return Option.none();
      yield* sql`UPDATE provider_dispatch_attempts
        SET state = 'may-have-been-sent', may_have_been_sent_at = ${input.at},
          updated_at = ${input.at}
        WHERE attempt_id = ${claimed.value} AND state = 'prepared'`;
      return yield* readAttempt(claimed.value);
    }).pipe(fail("markMayHaveBeenSent"));

  const acknowledgeWith: ProviderDispatchAttemptRepositoryShape["acknowledgeWith"] = (
    input,
    alongside,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* alongside;
          yield* sql`UPDATE provider_dispatch_attempts
            SET state = 'provider-acknowledged', acknowledged_at = ${input.at},
              turn_id = ${input.turnId}, provider = ${input.provider}, updated_at = ${input.at}
            WHERE attempt_id = ${input.attemptId}`.pipe(fail("acknowledgeWith"));
          yield* sql`UPDATE thread_recovery_intents
            SET turn_id = ${input.turnId}, provider = ${input.provider},
              revision = revision + 1, updated_at = ${input.at}
            WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}`.pipe(
            fail("acknowledgeWith"),
          );
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (error) =>
          Effect.fail(toPersistenceSqlError("ProviderDispatchAttempts.acknowledgeWith")(error)),
        ),
      );

  const latestForIntent: ProviderDispatchAttemptRepositoryShape["latestForIntent"] = (input) =>
    sql<AttemptRow>`SELECT ${columns} FROM provider_dispatch_attempts
      WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
      ORDER BY prepared_at DESC, updated_at DESC LIMIT 1`.pipe(
      Effect.map((rows) => Option.fromUndefinedOr(rows[0]).pipe(Option.map(toAttempt))),
      fail("latestForIntent"),
    );

  return {
    markMayHaveBeenSent,
    acknowledgeWith,
    latestForIntent,
  } satisfies ProviderDispatchAttemptRepositoryShape;
});

export const ProviderDispatchAttemptRepositoryLive = Layer.effect(
  ProviderDispatchAttemptRepository,
  make,
);
