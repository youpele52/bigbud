import { MessageId, ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderDispatchAttemptRepository } from "../Services/ProviderDispatchAttempts.ts";
import { ThreadRecoveryIntentRepository } from "../Services/ThreadRecoveryIntents.ts";
import { ProviderDispatchAttemptRepositoryLive } from "./ProviderDispatchAttempts.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadRecoveryIntentRepositoryLive } from "./ThreadRecoveryIntents.ts";

const layer = Layer.mergeAll(
  ThreadRecoveryIntentRepositoryLive,
  ProviderDispatchAttemptRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const at = (minute: number) => `2026-10-22T10:${String(minute).padStart(2, "0")}:00.000Z`;
const messageId = MessageId.makeUnsafe("m");
const turnId = TurnId.makeUnsafe("turn-ack");

/** An intent with one attempt in `may-have-been-sent`, and a probe table for the alongside writes. */
const seedAttempt = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const intents = yield* ThreadRecoveryIntentRepository;
    const attempts = yield* ProviderDispatchAttemptRepository;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS ack_probe (thread_id TEXT NOT NULL)`;
    yield* intents.recordAccepted({ threadId, messageId, provider: "codex", createdAt: at(0) });
    const attempt = Option.getOrThrow(
      yield* attempts.markMayHaveBeenSent({
        threadId,
        messageId,
        provider: "codex",
        payloadDigest: "d",
        at: at(1),
      }),
    );
    const ack = (attemptId: string) => ({
      attemptId,
      threadId,
      messageId,
      turnId,
      provider: "codex" as const,
      at: at(2),
    });
    const probe = sql`INSERT INTO ack_probe (thread_id) VALUES (${threadId})`;
    const probes = sql<{ count: number }>`SELECT COUNT(*) AS count FROM ack_probe
      WHERE thread_id = ${threadId}`.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));
    return { attempts, intents, attempt, ack, probe, probes };
  });

it.layer(layer)("provider dispatch attempt acknowledgement", (it) => {
  it.effect("acknowledgement rolls back when the attempt update itself fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("ack-missing");
      const seeded = yield* seedAttempt(threadId);
      // The attempt row is gone (pruned); nothing may be acknowledged, and the writes alongside
      // must not stand on their own inside the transaction.
      const exit = yield* Effect.exit(
        seeded.attempts.acknowledgeWith(seeded.ack("pruned-attempt"), seeded.probe),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* seeded.probes, 0);
      const intent = Option.getOrThrow(yield* seeded.intents.get({ threadId, messageId }));
      assert.isNull(intent.turnId);
      const open = Option.getOrThrow(
        yield* seeded.attempts.latestForIntent({ threadId, messageId }),
      );
      assert.strictEqual(open.state, "may-have-been-sent");
    }),
  );

  it.effect("acknowledges only an attempt that may have been sent, and only once", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("ack-once");
      const seeded = yield* seedAttempt(threadId);
      yield* seeded.attempts.acknowledgeWith(seeded.ack(seeded.attempt.attemptId), seeded.probe);
      assert.strictEqual(yield* seeded.probes, 1);
      const again = yield* Effect.exit(
        seeded.attempts.acknowledgeWith(seeded.ack(seeded.attempt.attemptId), seeded.probe),
      );
      assert.isTrue(Exit.isFailure(again));
      assert.strictEqual(yield* seeded.probes, 1);
      const acknowledged = Option.getOrThrow(
        yield* seeded.attempts.latestForIntent({ threadId, messageId }),
      );
      assert.strictEqual(acknowledged.state, "provider-acknowledged");
      assert.strictEqual(acknowledged.turnId, turnId);
    }),
  );
});
