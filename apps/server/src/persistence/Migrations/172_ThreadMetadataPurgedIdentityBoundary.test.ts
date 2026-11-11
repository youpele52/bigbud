import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { makeLegacyMetadataAdmission } from "../Layers/ThreadMetadataGeneration.legacy.admission.ts";
import {
  at,
  seedActivity,
  seedThread,
} from "../Layers/ThreadMetadataGeneration.legacy.test-helpers.ts";
import { makeEntityPurgeSql } from "../../deletion/Layers/EntityPurge.sql.ts";

it.effect("recreated purged thread IDs retain historical claim protection after upgrade", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 170 });
    const old = yield* seedThread("purged-before-boundary");
    yield* seedActivity(old, "old-model", "text-generation.model-succeeded", {
      provider: "codex",
      model: "verified",
    });
    yield* sql`INSERT INTO orchestration_thread_identity VALUES (${old}, ${old}, 1)`;
    yield* sql`INSERT INTO orchestration_command_receipt_claims
      (command_id, payload_digest_version, payload_digest, claimed_at)
      VALUES ('server:text-generation-status:historical', 'v1', 'retained', ${at})`;
    // Project purges retain a project job plus separate jobs for each child thread.
    for (const [kind, id] of [
      ["thread", old],
      ["thread", "purged-project-child"],
      ["project", "purged-project"],
    ])
      yield* sql`INSERT INTO purge_jobs (job_id, entity_kind, entity_id, phase, status,
        resource_manifest_json, created_at, updated_at, completed_at)
        VALUES (${`purge:${id}`}, ${kind}, ${id}, 'root', 'completed', '[]', ${at}, ${at}, ${at})`;
    yield* sql`INSERT INTO orchestration_deletion_markers
      (entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence)
      VALUES ('thread', ${old}, 1, ${at}, NULL)`;
    const purge = makeEntityPurgeSql(sql);
    yield* purge.deleteProvenReceipts({ entityKind: "thread", entityId: old });
    yield* purge.deleteProvenThreadCanonical({ threadId: old });
    yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${old}`;
    yield* sql`DELETE FROM projection_threads WHERE thread_id = ${old}`;
    yield* sql`DELETE FROM projection_projects WHERE project_id = ${old}`;
    yield* runMigrations({ toMigrationInclusive: 171 });
    assert.deepStrictEqual(yield* sql`SELECT * FROM thread_metadata_legacy_prior_threads`, []);
    yield* seedThread(old);
    yield* seedActivity(old, "new-model", "text-generation.model-succeeded", {
      provider: "codex",
      model: "verified",
    });
    yield* sql`INSERT INTO orchestration_thread_identity SELECT ${old}, ${old}, MAX(sequence) FROM orchestration_events`;
    const admit = yield* makeLegacyMetadataAdmission();
    // Reproduces the missing cohort evidence in an installation already on 171.
    assert.isTrue((yield* admit({ threadId: old, operation: "title" })).allowed);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 172 }), [
      [172, "ThreadMetadataPurgedIdentityBoundary"],
    ]);
    assert.isFalse((yield* admit({ threadId: old, operation: "title" })).allowed);
    assert.deepStrictEqual(
      yield* sql`SELECT thread_id FROM thread_metadata_legacy_prior_threads ORDER BY thread_id`,
      [{ thread_id: old }, { thread_id: "purged-project-child" }],
    );
    const fresh = yield* seedThread("genuinely-new");
    yield* seedActivity(fresh, "fresh-model", "text-generation.model-succeeded", {
      provider: "codex",
      model: "verified",
    });
    yield* sql`INSERT INTO orchestration_thread_identity SELECT ${fresh}, ${fresh}, MAX(sequence) FROM orchestration_events`;
    assert.isTrue((yield* admit({ threadId: fresh, operation: "title" })).allowed);
    assert.equal((yield* sql`SELECT * FROM purge_jobs`).length, 3);
    assert.equal((yield* sql`SELECT * FROM orchestration_command_receipt_claims`).length, 1);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 172 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
