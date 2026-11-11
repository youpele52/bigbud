import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { makeThreadMetadataGenerationRepository } from "./ThreadMetadataGeneration.ts";
import { makeLegacyMetadataAdmission } from "./ThreadMetadataGeneration.legacy.admission.ts";
import { seedActivity, seedThread } from "./ThreadMetadataGeneration.legacy.test-helpers.ts";

it.layer(SqlitePersistenceMemory)("historical metadata selection bootstrap", (it) => {
  it.effect(
    "recovers canonical sequence order outside the runtime tail without resetting state",
    () =>
      Effect.gen(function* () {
        const threadId = yield* seedThread("bootstrap-tail");
        const r = yield* makeThreadMetadataGenerationRepository();
        const sql = yield* SqlClient.SqlClient;
        yield* r.advanceMetadataRevision(threadId, "title");
        yield* r.advanceMetadataRevision(threadId, "summary");
        yield* sql`UPDATE thread_metadata_generation_state SET summary_attempted_frontier = 9 WHERE thread_id = ${threadId}`;
        yield* seedActivity(threadId, "z-bootstrap-old", "text-generation.model-succeeded", {
          provider: "codex",
          model: "old",
        });
        const selection = {
          provider: "claudeAgent",
          model: "verified",
          options: { effort: "high" },
        };
        yield* seedActivity(
          threadId,
          "a-bootstrap-latest",
          "text-generation.model-succeeded",
          selection,
        );
        for (let index = 0; index < 501; index++)
          yield* seedActivity(threadId, `tail-${index}`, "text-generation.deferred", {
            operation: "title",
          });
        // These are exactly the activities a trimmed runtime could retain. Neither model
        // survives there; canonical SQL (not timestamp or lexical activity ID) is proof.
        const tail = yield* sql<{ kind: string }>`SELECT kind FROM projection_thread_activities
        WHERE thread_id = ${threadId} ORDER BY rowid DESC LIMIT 500`;
        assert.isFalse(
          tail.some((activity) => activity.kind === "text-generation.model-succeeded"),
        );
        const before =
          yield* sql`SELECT successful_model_json FROM thread_metadata_generation_state WHERE thread_id = ${threadId}`;
        assert.deepStrictEqual(before, [{ successful_model_json: null }]);
        assert.deepStrictEqual(yield* r.readMetadataState(threadId), {
          titleRevision: 1,
          summaryRevision: 1,
          summaryAttemptedFrontier: 9,
          successfulModelJson: JSON.stringify(selection),
        });
        // Once recovered, the indexed state is used on ordinary reads rather than another
        // full-history scan. Even an unrelated later unknown claim does not erase success;
        // dispatch admission independently still refuses that history.
        yield* seedActivity(
          threadId,
          "unknown-after-bootstrap",
          "text-generation.started",
          {},
          false,
        );
        assert.strictEqual(
          (yield* r.readMetadataState(threadId)).successfulModelJson,
          JSON.stringify(selection),
        );
        const admit = yield* makeLegacyMetadataAdmission();
        assert.isFalse((yield* admit({ threadId, operation: "title" })).allowed);
        const newer = { provider: "codex", model: "new-canonical-success" };
        yield* r.recordSuccessfulModel(threadId, JSON.stringify(newer));
        assert.strictEqual(
          (yield* r.readMetadataState(threadId)).successfulModelJson,
          JSON.stringify(newer),
        );
      }),
  );

  it.effect("recovers model proof without turning legacy paid work into replay permission", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("bootstrap-paid");
      const selection = { provider: "codex", model: "historical" };
      yield* seedActivity(
        threadId,
        "bootstrap-paid-model",
        "text-generation.model-succeeded",
        selection,
      );
      yield* seedActivity(threadId, "bootstrap-paid-owner", "text-generation.request-started", {
        requestId: "owner",
      });
      const r = yield* makeThreadMetadataGenerationRepository();
      assert.strictEqual(
        (yield* r.readMetadataState(threadId)).successfulModelJson,
        JSON.stringify(selection),
      );
      const admit = yield* makeLegacyMetadataAdmission();
      for (const operation of ["title", "summary"] as const)
        assert.deepStrictEqual(yield* admit({ threadId, operation }), {
          allowed: false,
          reason: "legacy-paid-work",
        });
    }),
  );

  for (const fault of [
    "missing-receipt",
    "digest",
    "model",
    "projection",
    "canonical",
    "orphan",
  ] as const) {
    it.effect(
      `fails closed for ${fault} rather than trusting selected model or partial history`,
      () =>
        Effect.gen(function* () {
          const threadId = yield* seedThread(`bootstrap-invalid-${fault}`);
          const command = yield* seedActivity(
            threadId,
            `bootstrap-invalid-model-${fault}`,
            "text-generation.model-succeeded",
            {
              provider: "codex",
              model: "verified",
            },
          );
          const sql = yield* SqlClient.SqlClient;
          if (fault === "missing-receipt")
            yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id = ${command.commandId}`;
          if (fault === "digest")
            yield* sql`UPDATE orchestration_command_receipts SET payload_digest = 'corrupt' WHERE command_id = ${command.commandId}`;
          if (fault === "model")
            yield* seedActivity(threadId, "malformed-model", "text-generation.model-succeeded", {
              provider: "unknown",
            });
          if (fault === "projection")
            yield* sql`UPDATE projection_thread_activities SET payload_json = '{}' WHERE activity_id = ${command.activity.id}`;
          if (fault === "canonical")
            yield* sql`UPDATE orchestration_events SET payload_json = '{}' WHERE command_id = ${command.commandId}`;
          if (fault === "orphan")
            yield* seedActivity(
              threadId,
              "orphan-model-history",
              "text-generation.started",
              { operation: "summary" },
              false,
            );
          const r = yield* makeThreadMetadataGenerationRepository();
          assert.isNull((yield* r.readMetadataState(threadId)).successfulModelJson);
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM thread_metadata_generation_state WHERE thread_id = ${threadId}`,
            [],
          );
        }),
    );
  }

  it.effect("keeps bootstrap and newer success inside the caller's transaction rollback", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("bootstrap-nested-rollback");
      const historical = { provider: "codex", model: "historical" };
      const newer = { provider: "codex", model: "newer" };
      yield* seedActivity(threadId, "nested-model", "text-generation.model-succeeded", historical);
      const r = yield* makeThreadMetadataGenerationRepository();
      const sql = yield* SqlClient.SqlClient;
      const outcome = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            assert.strictEqual(
              (yield* r.readMetadataState(threadId)).successfulModelJson,
              JSON.stringify(historical),
            );
            yield* r.recordSuccessfulModel(threadId, JSON.stringify(newer));
            assert.strictEqual(
              (yield* r.readMetadataState(threadId)).successfulModelJson,
              JSON.stringify(newer),
            );
            return yield* Effect.fail("outer canonical transaction rolled back");
          }),
        )
        .pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM thread_metadata_generation_state WHERE thread_id = ${threadId}`,
        [],
      );
      assert.strictEqual(
        (yield* r.readMetadataState(threadId)).successfulModelJson,
        JSON.stringify(historical),
      );
    }),
  );

  it.effect("does not substitute the selected model when no verified history exists", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("bootstrap-selected-only");
      const r = yield* makeThreadMetadataGenerationRepository();
      assert.isNull((yield* r.readMetadataState(threadId)).successfulModelJson);
    }),
  );

  it.effect(
    "includes initial SQL acquisition in the deadline and leaves no partial bootstrap",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = yield* seedThread("bootstrap-timeout");
          yield* seedActivity(threadId, "timeout-model", "text-generation.model-succeeded", {
            provider: "codex",
            model: "verified",
          });
          const r = yield* makeThreadMetadataGenerationRepository();
          const sql = yield* SqlClient.SqlClient;
          const acquired = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const holder = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* Deferred.succeed(acquired, undefined);
                yield* Deferred.await(release);
              }),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(acquired);
          const waiting = yield* r
            .readMetadataState(threadId)
            .pipe(Effect.result, Effect.forkScoped);
          yield* TestClock.adjust("2 seconds");
          const outcome = yield* Fiber.join(waiting);
          assert.strictEqual(outcome._tag, "Failure");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(holder);
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM thread_metadata_generation_state WHERE thread_id = ${threadId}`,
            [],
          );
          assert.strictEqual(
            (yield* r.readMetadataState(threadId)).successfulModelJson,
            JSON.stringify({ provider: "codex", model: "verified" }),
          );
        }),
      ),
  );
});
