import { createHash } from "node:crypto";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { restoreBaselinePayload } from "../Layers/ProjectionBaselines.restoreRows.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  hashBaselinePayload,
  PROJECTION_BASELINE_FORMAT_VERSION,
  storedBaselinePayloadSource,
} from "../ProjectionBaselineRows.ts";
import { PROJECTION_BASELINE_TABLES } from "../ProjectionBaselineSchema.ts";
import { LEGACY_BASELINE_HASH_CHUNK_BYTES } from "./152_ProjectionBaselineRows.ts";

const NOW = "2026-11-05T00:00:00.000Z";
// Multi-byte characters, escapes and numbers, repeated past one hash chunk so a chunk
// boundary falls inside a multi-byte sequence.
const TRICKY = 'héllo 🚀 "quoted" \\ back\nline   tab\t ';
const LONG_TITLE = TRICKY.repeat(Math.ceil((LEGACY_BASELINE_HASH_CHUNK_BYTES + 4096) / 40));

const project = (projectId: string, title: string) => ({
  created_at: NOW,
  execution_target_id: "local",
  project_id: projectId,
  scripts_json: "[]",
  title,
  updated_at: NOW,
  workspace_root: "/tmp/project",
});

const legacyPayload = (tables: ReadonlyArray<string>, projects: ReadonlyArray<unknown>) => {
  const payloadJson = JSON.stringify({
    tables: Object.fromEntries(
      tables.map((table) => [table, table === "projection_projects" ? projects : []]),
    ),
  });
  return { payloadJson, payloadHash: createHash("sha256").update(payloadJson).digest("hex") };
};

const insertLegacy = (
  sequence: number,
  status: "candidate" | "verified",
  payload: { readonly payloadJson: string; readonly payloadHash: string },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_baselines (sequence, format_version, payload_json,
        payload_hash, verification_status, created_at)
      VALUES (${sequence}, 1, ${payload.payloadJson}, ${payload.payloadHash}, ${status}, ${NOW})`;
  });

const baselineAt = (sequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly baselineId: number;
      readonly formatVersion: number;
      readonly payloadJson: string;
      readonly payloadHash: string;
    }>`SELECT baseline_id AS "baselineId", format_version AS "formatVersion",
        payload_json AS "payloadJson", payload_hash AS "payloadHash"
      FROM projection_baselines WHERE sequence = ${sequence}`;
    return rows[0];
  });

it.effect("152 converts verified legacy baselines to rows without changing their hash", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 151 });
    const current = legacyPayload(PROJECTION_BASELINE_TABLES, [
      project("project-long", LONG_TITLE),
      project("project-number", "1.5e+300"),
    ]);
    assert.isAbove(Buffer.byteLength(current.payloadJson), LEGACY_BASELINE_HASH_CHUNK_BYTES);
    const withoutCodex = legacyPayload(
      PROJECTION_BASELINE_TABLES.filter((table) => !table.startsWith("projection_usage_codex")),
      [project("project-old", "old")],
    );
    yield* insertLegacy(10, "verified", current);
    yield* insertLegacy(7, "verified", withoutCodex);
    yield* insertLegacy(20, "candidate", current);
    yield* insertLegacy(5, "verified", { ...current, payloadHash: "f".repeat(64) });

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 152 }), [
      [152, "ProjectionBaselineRows"],
    ]);

    // Candidates are recreated later; a payload that fails its own hash is not trusted.
    assert.isUndefined(yield* baselineAt(20));
    assert.isUndefined(yield* baselineAt(5));

    const converted = (yield* baselineAt(10))!;
    assert.equal(converted.formatVersion, PROJECTION_BASELINE_FORMAT_VERSION);
    assert.equal(converted.payloadJson, "");
    // The canonical row document is byte-identical to the legacy string.
    assert.equal(converted.payloadHash, current.payloadHash);
    assert.equal(
      yield* hashBaselinePayload(storedBaselinePayloadSource(sql, converted.baselineId, null)),
      current.payloadHash,
    );

    // A legacy payload without the additive Codex tables gets a hash over the full table set.
    const old = (yield* baselineAt(7))!;
    assert.notEqual(old.payloadHash, withoutCodex.payloadHash);
    assert.equal(
      yield* hashBaselinePayload(storedBaselinePayloadSource(sql, old.baselineId, null)),
      old.payloadHash,
    );

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 152 }), []);

    yield* runMigrations();
    yield* restoreBaselinePayload(
      sql,
      storedBaselinePayloadSource(sql, converted.baselineId, converted.payloadHash),
      10,
      [],
    );
    assert.deepEqual(
      yield* sql`SELECT project_id, title FROM projection_projects
        WHERE project_id <> '__chats__' ORDER BY project_id`,
      [
        { project_id: "project-long", title: LONG_TITLE },
        { project_id: "project-number", title: "1.5e+300" },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
