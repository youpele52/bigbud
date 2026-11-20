import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { calculateCommandPayloadDigest } from "../../orchestration/commandDigest.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { makeLegacyMetadataAdmission } from "../Layers/ThreadMetadataGeneration.legacy.admission.ts";
import {
  at,
  seedActivity,
  seedThread,
} from "../Layers/ThreadMetadataGeneration.legacy.test-helpers.ts";

it.effect(
  "historical claims fence prior IDs but cannot fence new threads after the durable boundary",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 170 });
      const old = yield* seedThread("prior-thread");
      yield* seedActivity(old, "old-success", "text-generation.model-succeeded", {
        provider: "codex",
        model: "verified",
      });
      yield* sql`INSERT INTO orchestration_thread_identity VALUES (${old}, ${old}, 1)`;
      yield* sql`INSERT INTO orchestration_command_receipt_claims
      (command_id, payload_digest_version, payload_digest, claimed_at)
      VALUES ('server:text-generation-status:historical', 'v1', 'original', ${at})`;
      // Compaction can empty the event log; AUTOINCREMENT still retains its watermark.
      yield* sql`DELETE FROM orchestration_events`;
      yield* sql`UPDATE orchestration_retention_state SET retained_through_sequence = 1000 WHERE singleton_id = 1`;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 171 }), [
        [171, "ThreadMetadataLegacyClaimBoundary"],
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT through_sequence FROM thread_metadata_legacy_claim_boundary`,
        [{ through_sequence: 1000 }],
      );
      // The production event store allocates above the canonical frontier.
      yield* sql`UPDATE sqlite_sequence SET seq = 1000 WHERE name = 'orchestration_events'`;
      const admit = yield* makeLegacyMetadataAdmission();
      assert.equal((yield* admit({ threadId: old, operation: "title" })).allowed, false);
      const fresh = yield* seedThread("new-thread");
      yield* seedActivity(fresh, "fresh-success", "text-generation.model-succeeded", {
        provider: "codex",
        model: "verified",
      });
      const [event] = yield* sql<{
        sequence: number;
      }>`SELECT MAX(sequence) AS sequence FROM orchestration_events`;
      yield* sql`INSERT INTO orchestration_thread_identity VALUES (${fresh}, ${fresh}, ${event!.sequence})`;
      const binding = yield* seedActivity(
        fresh,
        "fresh-binding",
        "text-generation.user-turn-bound",
        { messageId: "first-message" },
      );
      const turnId = TurnId.makeUnsafe("first-turn");
      const activity = { ...binding.activity, turnId };
      const digest = calculateCommandPayloadDigest({ ...binding, activity });
      yield* sql`UPDATE orchestration_events SET payload_json = ${JSON.stringify({ threadId: fresh, activity })} WHERE command_id = ${binding.commandId}`;
      yield* sql`UPDATE orchestration_command_receipts SET payload_digest = ${digest.digest} WHERE command_id = ${binding.commandId}`;
      yield* sql`UPDATE projection_thread_activities SET turn_id = ${turnId}, sequence = (SELECT result_sequence FROM orchestration_command_receipts WHERE command_id = ${binding.commandId}) WHERE activity_id = ${activity.id}`;
      assert.deepStrictEqual(yield* admit({ threadId: fresh, operation: "title" }), {
        allowed: true,
        successfulModel: { provider: "codex", model: "verified" },
      });
      // Recreating a known ID cannot turn historical ambiguity into permission.
      yield* sql`UPDATE orchestration_thread_identity SET created_sequence = 2000 WHERE thread_id = ${old}`;
      assert.equal((yield* admit({ threadId: old, operation: "title" })).allowed, false);
      // A changed claim is fresh evidence, even if it reuses a snapshotted command ID.
      yield* sql`UPDATE orchestration_command_receipt_claims SET payload_digest = 'changed'`;
      assert.equal((yield* admit({ threadId: fresh, operation: "title" })).allowed, false);
      yield* sql`UPDATE orchestration_command_receipt_claims SET payload_digest = 'original'`;
      yield* sql`INSERT INTO orchestration_command_receipt_claims
      (command_id, payload_digest_version, payload_digest, claimed_at)
      VALUES ('server:text-generation-status:new', 'v1', 'new', ${at})`;
      assert.equal((yield* admit({ threadId: fresh, operation: "title" })).allowed, false);
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 171 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
