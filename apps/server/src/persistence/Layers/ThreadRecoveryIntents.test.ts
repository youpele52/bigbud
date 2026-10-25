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
const message = (id: string) => MessageId.makeUnsafe(id);

it.layer(layer)("thread recovery intents", (it) => {
  it.effect("records one active intent per accepted turn; a pre-seeded row wins", () =>
    Effect.gen(function* () {
      const intents = yield* ThreadRecoveryIntentRepository;
      const threadId = ThreadId.makeUnsafe("intent-seed");
      yield* intents.recordAccepted({
        threadId,
        messageId: message("c"),
        provider: "claudeAgent",
        createdAt: at(0),
        attemptCount: 2,
        detail: { continuationOf: message("a") },
      });
      yield* intents.recordAccepted({
        threadId,
        messageId: message("c"),
        provider: "claudeAgent",
        createdAt: at(1),
      });
      const intent = Option.getOrThrow(yield* intents.get({ threadId, messageId: message("c") }));
      assert.strictEqual(intent.disposition, "active");
      assert.strictEqual(intent.recoveryStatus, "none");
      assert.strictEqual(intent.attemptCount, 2);
      assert.strictEqual(intent.detail.continuationOf, "a");
    }),
  );

  it.effect("a new turn settles older intents except the one it continues", () =>
    Effect.gen(function* () {
      const intents = yield* ThreadRecoveryIntentRepository;
      const threadId = ThreadId.makeUnsafe("intent-supersede");
      for (const id of ["a", "b"]) {
        yield* intents.recordAccepted({
          threadId,
          messageId: message(id),
          provider: "codex",
          createdAt: at(0),
        });
      }
      const a = Option.getOrThrow(yield* intents.get({ threadId, messageId: message("a") }));
      assert.isTrue(
        yield* intents.transition({
          key: { threadId, messageId: message("a") },
          expectedRevision: a.revision,
          patch: { recoveryStatus: "continuing", continuationMessageId: message("c") },
          at: at(1),
        }),
      );
      yield* intents.settleSupersededByTurnStart({ threadId, messageId: message("c"), at: at(2) });
      const after = (id: string) =>
        intents.get({ threadId, messageId: message(id) }).pipe(Effect.map(Option.getOrThrow));
      assert.strictEqual((yield* after("a")).disposition, "active");
      assert.strictEqual((yield* after("b")).disposition, "settled");
    }),
  );

  it.effect("Stop revokes, stopAll suspends, and CAS refuses a stale revision", () =>
    Effect.gen(function* () {
      const intents = yield* ThreadRecoveryIntentRepository;
      const stopped = ThreadId.makeUnsafe("intent-stopped");
      const exiting = ThreadId.makeUnsafe("intent-exiting");
      for (const threadId of [stopped, exiting]) {
        yield* intents.recordAccepted({
          threadId,
          messageId: message("m"),
          provider: "codex",
          createdAt: at(0),
        });
      }
      yield* intents.revokeForThread({ threadId: stopped, at: at(1) });
      const suspended = yield* intents.suspendActiveForExit({ at: at(2) });
      assert.isTrue(suspended >= 1);
      const stoppedIntent = Option.getOrThrow(
        yield* intents.get({ threadId: stopped, messageId: message("m") }),
      );
      const exitingIntent = Option.getOrThrow(
        yield* intents.get({ threadId: exiting, messageId: message("m") }),
      );
      assert.strictEqual(stoppedIntent.disposition, "revoked");
      assert.strictEqual(exitingIntent.disposition, "suspended-for-exit");
      assert.isFalse(
        yield* intents.transition({
          key: { threadId: exiting, messageId: message("m") },
          expectedRevision: exitingIntent.revision - 1,
          patch: { recoveryStatus: "awaiting-user" },
          at: at(3),
        }),
      );
    }),
  );

  it.effect("records may-have-been-sent durably and keeps at most one open attempt", () =>
    Effect.gen(function* () {
      const intents = yield* ThreadRecoveryIntentRepository;
      const attempts = yield* ProviderDispatchAttemptRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("attempt-open");
      const untracked = yield* attempts.markMayHaveBeenSent({
        threadId,
        messageId: message("no-intent"),
        provider: "codex",
        payloadDigest: "d0",
        at: at(0),
      });
      assert.isTrue(Option.isNone(untracked));
      yield* intents.recordAccepted({
        threadId,
        messageId: message("m"),
        provider: "codex",
        createdAt: at(0),
      });
      const first = Option.getOrThrow(
        yield* attempts.markMayHaveBeenSent({
          threadId,
          messageId: message("m"),
          provider: "codex",
          payloadDigest: "d1",
          at: at(1),
        }),
      );
      assert.strictEqual(first.state, "may-have-been-sent");
      const resend = Option.getOrThrow(
        yield* attempts.markMayHaveBeenSent({
          threadId,
          messageId: message("m"),
          provider: "codex",
          payloadDigest: "d1",
          at: at(2),
        }),
      );
      assert.strictEqual(resend.attemptId, first.attemptId);
      const insertSecondOpen = yield* Effect.exit(
        sql`INSERT INTO provider_dispatch_attempts (
          attempt_id, thread_id, message_id, intent_revision, payload_digest, state,
          prepared_at, updated_at
        ) VALUES ('second', ${threadId}, 'm', 0, 'd2', 'prepared', ${at(3)}, ${at(3)})`,
      );
      assert.isTrue(Exit.isFailure(insertSecondOpen));
      const uncertain = yield* intents.listUncertainAfterRestart();
      assert.isTrue(uncertain.some((intent) => intent.threadId === threadId));
    }),
  );

  it.effect("acknowledges atomically with the liveness writes", () =>
    Effect.gen(function* () {
      const intents = yield* ThreadRecoveryIntentRepository;
      const attempts = yield* ProviderDispatchAttemptRepository;
      const threadId = ThreadId.makeUnsafe("attempt-ack");
      const turnId = TurnId.makeUnsafe("turn-ack");
      yield* intents.recordAccepted({
        threadId,
        messageId: message("m"),
        provider: "codex",
        createdAt: at(0),
      });
      const attempt = Option.getOrThrow(
        yield* attempts.markMayHaveBeenSent({
          threadId,
          messageId: message("m"),
          provider: "codex",
          payloadDigest: "d",
          at: at(1),
        }),
      );
      const ack = {
        attemptId: attempt.attemptId,
        threadId,
        messageId: message("m"),
        turnId,
        provider: "codex" as const,
        at: at(2),
      };
      const failed = yield* Effect.exit(attempts.acknowledgeWith(ack, Effect.fail("liveness")));
      assert.isTrue(Exit.isFailure(failed));
      const stillOpen = Option.getOrThrow(
        yield* attempts.latestForIntent({ threadId, messageId: message("m") }),
      );
      assert.strictEqual(stillOpen.state, "may-have-been-sent");
      yield* attempts.acknowledgeWith(ack, Effect.void);
      const acknowledged = Option.getOrThrow(
        yield* attempts.latestForIntent({ threadId, messageId: message("m") }),
      );
      assert.strictEqual(acknowledged.state, "provider-acknowledged");
      const intent = Option.getOrThrow(yield* intents.get({ threadId, messageId: message("m") }));
      assert.strictEqual(intent.turnId, turnId);
    }),
  );

  it.effect("reports a remote shell owner only while its outcome is uncertain", () =>
    Effect.gen(function* () {
      const intents = yield* ThreadRecoveryIntentRepository;
      const sql = yield* SqlClient.SqlClient;
      const owned = (threadId: string, state: string) =>
        sql`INSERT INTO remote_agent_runtime_owners (owner_key, route_json)
          VALUES (${`shell:${threadId}`}, ${JSON.stringify({ state })})`;
      yield* owned("shell-sent", "may-have-been-sent");
      yield* owned("shell-unknown", "outcome-unknown");
      yield* owned("shell-done", "terminal");
      yield* owned("shell-prepared", "prepared");
      const check = (id: string) => intents.hasUncertainRemoteShell(ThreadId.makeUnsafe(id));
      assert.isTrue(yield* check("shell-sent"));
      assert.isTrue(yield* check("shell-unknown"));
      assert.isFalse(yield* check("shell-done"));
      assert.isFalse(yield* check("shell-prepared"));
      assert.isFalse(yield* check("shell-none"));
    }),
  );
});
