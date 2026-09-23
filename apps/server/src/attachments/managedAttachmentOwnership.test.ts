import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ServerConfig } from "../startup/config.ts";
import { reconcileStagedManagedAttachments } from "./managedAttachmentOwnership.ts";

const layer = it.layer(
  Layer.mergeAll(
    SqlitePersistenceMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "managed-attachment-recovery-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
);
const id = (last: string) => `thread-11111111-1111-4111-8111-111111111111-${last}`;

layer("managed attachment staged write recovery", (it) => {
  it.effect(
    "publishes verified interrupted writes and blocks missing or changed files idempotently",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const config = yield* ServerConfig;
        const now = new Date("2026-09-23T12:00:00.000Z");
        const createdAt = "2026-09-23T00:00:00.000Z";
        const bytes = Buffer.from("content");
        const digest = createHash("sha256").update(bytes).digest("hex");
        const good = id("22222222-2222-4222-8222-222222222222");
        const changed = id("33333333-3333-4333-8333-333333333333");
        const missing = id("44444444-4444-4444-8444-444444444444");
        for (const attachmentId of [good, changed, missing]) {
          yield* sql`
          INSERT INTO managed_attachment_ownership
            (attachment_id, relative_path, creator_thread_id, content_sha256,
              size_bytes, lifecycle, created_at)
          VALUES (${attachmentId}, ${`${attachmentId}.png`}, 'creator', ${digest},
            ${bytes.length}, 'staged', ${createdAt})
        `;
        }
        yield* Effect.promise(() => writeFile(join(config.attachmentsDir, `${good}.png`), bytes));
        yield* Effect.promise(() =>
          writeFile(join(config.attachmentsDir, `${changed}.png`), "changed"),
        );
        assert.equal(yield* reconcileStagedManagedAttachments(config.attachmentsDir, now), 3);
        assert.equal(yield* reconcileStagedManagedAttachments(config.attachmentsDir, now), 0);
        const rows = yield* sql<{
          attachmentId: string;
          lifecycle: string;
          fileId: string | null;
          blockedReason: string | null;
        }>`
        SELECT attachment_id AS "attachmentId", lifecycle, file_id AS "fileId",
          blocked_reason AS "blockedReason"
        FROM managed_attachment_ownership ORDER BY attachment_id
      `;
        assert.deepEqual(
          rows.map((row) => [row.attachmentId, row.lifecycle, row.blockedReason]),
          [
            [good, "published", null],
            [changed, "blocked", "staged_file_unverified"],
            [missing, "blocked", "staged_file_unverified"],
          ],
        );
        assert.isNotNull(rows[0]?.fileId);
      }),
  );
});

it("reconciles an interrupted staged write after a database restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bigbud-staged-restart-"));
  const attachmentsDir = join(directory, "attachments");
  const filename = join(directory, "state.sqlite");
  const attachmentId =
    "thread-11111111-1111-4111-8111-111111111111-55555555-5555-4555-8555-555555555555";
  const relativePath = `${attachmentId}.png`;
  const bytes = Buffer.from("restart-content");
  const digest = createHash("sha256").update(bytes).digest("hex");
  try {
    await mkdir(attachmentsDir);
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`
          INSERT INTO managed_attachment_ownership
            (attachment_id, relative_path, creator_thread_id, content_sha256,
              size_bytes, lifecycle, created_at)
          VALUES (${attachmentId}, ${relativePath}, 'creator', ${digest},
            ${bytes.length}, 'staged', '2026-09-23T00:00:00.000Z')
        `;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );
    await writeFile(join(attachmentsDir, relativePath), bytes);
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          yield* reconcileStagedManagedAttachments(
            attachmentsDir,
            new Date("2026-09-23T12:00:00.000Z"),
          ),
          1,
        );
        const rows = yield* sql<{ lifecycle: string; fileId: string | null }>`
          SELECT lifecycle, file_id AS "fileId" FROM managed_attachment_ownership
          WHERE attachment_id = ${attachmentId}
        `;
        assert.equal(rows[0]?.lifecycle, "published");
        assert.isNotNull(rows[0]?.fileId);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
