import { assert, it } from "@effect/vitest";
import { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { calculateCommandPayloadDigest } from "../../orchestration/commandDigest.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeLegacyMetadataAdmission } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.admission.ts";
import {
  at,
  seedActivity,
  seedThread,
} from "../../persistence/Layers/ThreadMetadataGeneration.legacy.test-helpers.ts";
import { makeEntityPurgeSql } from "./EntityPurge.sql.ts";

it.layer(SqlitePersistenceMemory)("purged metadata command claims", (it) => {
  it.effect("project claims follow verified receipt coverage, never an unverified marker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("purged-project-claims");
      yield* sql`INSERT INTO projection_baselines
        (sequence, format_version, payload_json, payload_hash, verification_status, created_at)
        VALUES (10, 1, '{}', 'test', 'candidate', ${at})`;
      yield* sql`INSERT INTO orchestration_deletion_markers
        (entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence)
        VALUES ('project', ${projectId}, 10, ${at}, 10)`;
      for (const sequence of [5, 11]) {
        const commandId = `project-purge-claim:${sequence}`;
        yield* sql`INSERT INTO orchestration_command_receipts
          (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status,
            payload_digest_version, payload_digest)
          VALUES (${commandId}, 'project', ${projectId}, ${at}, ${sequence}, 'accepted', 'v1', 'digest')`;
        yield* sql`INSERT INTO orchestration_command_receipt_claims
          (command_id, payload_digest_version, payload_digest, claimed_at)
          VALUES (${commandId}, 'v1', 'digest', ${at})`;
      }
      const queries = makeEntityPurgeSql(sql);
      const input = { entityKind: "project" as const, entityId: projectId };
      yield* queries.deleteProvenReceipts(input);
      const claims = () => sql<{ command_id: string }>`SELECT command_id
        FROM orchestration_command_receipt_claims WHERE command_id LIKE 'project-purge-claim:%'
        ORDER BY command_id`;
      assert.strictEqual((yield* claims()).length, 2);
      yield* sql`UPDATE projection_baselines SET verification_status = 'verified' WHERE sequence = 10`;
      yield* queries.deleteProvenReceipts(input);
      assert.deepStrictEqual(yield* claims(), [{ command_id: "project-purge-claim:11" }]);
      assert.deepStrictEqual(
        yield* sql`SELECT command_id FROM orchestration_command_receipts
        WHERE aggregate_kind = 'project' AND aggregate_id = ${projectId}`,
        [{ command_id: "project-purge-claim:11" }],
      );
    }),
  );
  for (const rollback of [false, true]) {
    it.effect(`proven receipt purge is atomic with its digest claims, rollback=${rollback}`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const deleted = yield* seedThread(`purged-metadata-${rollback}`);
        const live = yield* seedThread(`live-metadata-${rollback}`);
        const deletedCommand = yield* seedActivity(
          deleted,
          `text-generation-status:deleted-${rollback}`,
          "text-generation.started",
          { operation: "title" },
        );
        const liveCommand = yield* seedActivity(
          live,
          `text-generation-status:live-${rollback}`,
          "text-generation.started",
          { operation: "summary" },
        );
        for (const command of [deletedCommand, liveCommand]) {
          const digest = calculateCommandPayloadDigest(command);
          yield* sql`INSERT INTO orchestration_command_receipt_claims
            (command_id, payload_digest_version, payload_digest, claimed_at)
            VALUES (${command.commandId}, ${digest.version}, ${digest.digest}, ${at})`;
        }
        const queries = makeEntityPurgeSql(sql);
        // Without the existing deletion marker, neither receipts nor claims qualify.
        yield* queries.deleteProvenReceipts({ entityKind: "thread", entityId: deleted });
        assert.strictEqual(
          (yield* sql`SELECT command_id FROM orchestration_command_receipt_claims
          WHERE command_id = ${deletedCommand.commandId}`).length,
          1,
        );
        yield* sql`INSERT INTO orchestration_deletion_markers
          (entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence)
          VALUES ('thread', ${deleted}, 1, ${at}, NULL)`;
        const purge = Effect.gen(function* () {
          yield* queries.deleteProvenReceipts({ entityKind: "thread", entityId: deleted });
          yield* queries.deleteProvenThreadCanonical({ threadId: deleted });
          yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${deleted}`;
          if (rollback) return yield* Effect.fail("injected purge failure");
        });
        const result = yield* Effect.exit(sql.withTransaction(purge));
        assert.strictEqual(Exit.isFailure(result), rollback);
        const claims = yield* sql<{ command_id: string }>`SELECT command_id
          FROM orchestration_command_receipt_claims
          WHERE command_id IN (${deletedCommand.commandId}, ${liveCommand.commandId}) ORDER BY command_id`;
        assert.deepStrictEqual(
          claims.map((row) => row.command_id),
          rollback ? [deletedCommand.commandId, liveCommand.commandId] : [liveCommand.commandId],
        );
        const admit = yield* makeLegacyMetadataAdmission();
        // The live summary's paid-work fence remains; purging another thread must
        // not create an unattributable claim that blocks its unrelated title.
        assert.isTrue((yield* admit({ threadId: live, operation: "title" })).allowed);
        assert.deepStrictEqual(yield* admit({ threadId: live, operation: "summary" }), {
          allowed: false,
          reason: "legacy-paid-work",
        });
        // Truly unattributable pre-existing evidence must never be erased as repair.
        yield* sql`INSERT INTO orchestration_command_receipt_claims
          (command_id, payload_digest_version, payload_digest, claimed_at)
          VALUES ('server:text-generation-status:unknown', 'unknown', 'retained', ${at})`;
        yield* queries.deleteProvenReceipts({ entityKind: "thread", entityId: deleted });
        assert.deepStrictEqual(yield* admit({ threadId: live, operation: "title" }), {
          allowed: false,
          reason: "unknown-evidence",
        });
        yield* sql`DELETE FROM orchestration_command_receipt_claims
          WHERE command_id = 'server:text-generation-status:unknown'`;
      }),
    );
  }
});
