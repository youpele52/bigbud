import { existsSync } from "node:fs";
import { link, lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../startup/config.ts";
import { AttachmentMaintenance } from "../Services/AttachmentMaintenance.ts";
import {
  attachmentIdFor,
  DAY_MS,
  makeAttachmentMaintenanceTestLayer,
  OTHER_THREAD_ID,
  referenceAttachment,
  seedThread,
  THREAD_ID,
  writeAttachmentFile,
} from "./AttachmentMaintenance.test.helpers.ts";

// Files are written now (ctime) and the ticks run 8 days later, past the 7-day grace period.
const START_MS = Date.now() + 8 * DAY_MS;
const promise = <A>(run: () => Promise<A>) => Effect.promise(run);
const trashNames = (root: string) =>
  promise(async () =>
    existsSync(path.join(root, ".trash")) ? readdir(path.join(root, ".trash")) : [],
  );

it.effect("moves only old unreferenced managed files to trash, then deletes them later", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { attachmentsDir: root, stateDir } = yield* ServerConfig;
    const maintenance = yield* AttachmentMaintenance;
    yield* seedThread(THREAD_ID);
    const orphan = `${attachmentIdFor(THREAD_ID, 1)}.png`;
    const referenced = `${attachmentIdFor(THREAD_ID, 2)}.png`;
    const staged = `${attachmentIdFor(THREAD_ID, 3)}.png`;
    const young = `${attachmentIdFor(THREAD_ID, 4)}.png`;
    const claimed = `${attachmentIdFor(THREAD_ID, 5)}.png`;
    const linked = `${attachmentIdFor(THREAD_ID, 6)}.png`;
    for (const name of [orphan, referenced, staged, claimed]) {
      yield* promise(() => writeAttachmentFile(root, name, name));
    }
    // Modified 5 days after the first tick: younger than the grace period at every tick below.
    yield* promise(() => writeAttachmentFile(root, young, "young", START_MS + 5 * DAY_MS));
    for (const name of ["notes.png", "README", `${attachmentIdFor(THREAD_ID, 7)}.exe`]) {
      yield* promise(() => writeAttachmentFile(root, name, name));
    }
    // An upload staging directory still holding its file: never swept, whatever its age.
    yield* promise(() =>
      writeAttachmentFile(path.join(root, ".submission-upload-abc123"), "upload", "bytes"),
    );
    const outside = yield* promise(() => writeAttachmentFile(stateDir, "outside.png", "outside"));
    yield* promise(() => symlink(outside, path.join(root, linked)));
    yield* referenceAttachment(THREAD_ID, "message-referenced", attachmentIdFor(THREAD_ID, 2));
    yield* sql`INSERT INTO managed_attachment_ownership
      (attachment_id, relative_path, creator_thread_id, content_sha256, size_bytes, lifecycle,
        created_at)
      VALUES (${attachmentIdFor(THREAD_ID, 3)}, ${staged}, ${THREAD_ID}, ${"a".repeat(64)}, 1,
        'staged', '2026-09-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO managed_attachment_ownership
      (attachment_id, relative_path, creator_thread_id, content_sha256, size_bytes, lifecycle,
        file_device, file_id, created_at, published_at)
      VALUES (${attachmentIdFor(THREAD_ID, 1)}, ${orphan}, ${THREAD_ID}, ${"b".repeat(64)}, 1,
        'published', '1', '1', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`;
    // A resumable (failed) legacy purge job still claims this path.
    yield* sql`INSERT INTO purge_jobs
      (job_id, entity_kind, entity_id, phase, status, resource_manifest_json, created_at,
        updated_at)
      VALUES ('failed-job', 'thread', ${OTHER_THREAD_ID}, 'files', 'failed', '[]',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO purge_resource_claims
      (job_id, entity_kind, entity_id, resource_kind, relative_path, canonical_path, device,
        inode, resource_type, claimed_at)
      VALUES ('failed-job', 'thread', ${OTHER_THREAD_ID}, 'attachment', ${claimed},
        ${path.join(root, claimed)}, 1, 1, 'file', '2026-09-01T00:00:00.000Z')`;

    const first = yield* maintenance.runTick({ nowMs: START_MS });
    assert.equal(first.status, "completed");
    assert.equal(first.sweep.trashed, 1);
    assert.equal(first.sweep.held, 2);
    assert.deepEqual(yield* trashNames(root), [`${Math.floor(START_MS)}__${orphan}`]);
    assert.isFalse(existsSync(path.join(root, orphan)));
    const untouched = [referenced, staged, young, claimed, "notes.png", "README"];
    for (const name of [...untouched, `${attachmentIdFor(THREAD_ID, 7)}.exe`]) {
      assert.isTrue(existsSync(path.join(root, name)), name);
    }
    assert.isTrue((yield* promise(() => lstat(path.join(root, linked)))).isSymbolicLink());
    assert.equal(yield* promise(() => readFile(outside, "utf8")), "outside");
    assert.isTrue(existsSync(path.join(root, ".submission-upload-abc123")));

    const notDue = yield* maintenance.runTick({ nowMs: START_MS + 6 * DAY_MS });
    assert.equal(notDue.sweep.deleted, 0);
    assert.equal(notDue.sweep.trashed, 0, "the young file is still inside its grace period");
    assert.lengthOf(yield* trashNames(root), 1);

    const due = yield* maintenance.runTick({ nowMs: START_MS + 7 * DAY_MS });
    assert.equal(due.sweep.deleted, 1);
    assert.deepEqual(
      (yield* trashNames(root)).filter((name) => name.endsWith(orphan)),
      [],
    );
    const ownership = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM managed_attachment_ownership
      WHERE attachment_id = ${attachmentIdFor(THREAD_ID, 1)}`;
    assert.equal(ownership[0]?.count, 0);
    for (const name of untouched) assert.isTrue(existsSync(path.join(root, name)), name);
  }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);

it.effect("restores a trashed file that is referenced again, keeping its inode", () =>
  Effect.gen(function* () {
    const { attachmentsDir: root } = yield* ServerConfig;
    const maintenance = yield* AttachmentMaintenance;
    yield* seedThread(THREAD_ID);
    const attachmentId = attachmentIdFor(THREAD_ID, 10);
    const fileName = `${attachmentId}.png`;
    const original = yield* promise(() => writeAttachmentFile(root, fileName, "restore me"));
    const inode = (yield* promise(() => lstat(original))).ino;

    assert.equal((yield* maintenance.runTick({ nowMs: START_MS })).sweep.trashed, 1);
    yield* referenceAttachment(THREAD_ID, "message-again", attachmentId);
    const restored = yield* maintenance.runTick({ nowMs: START_MS + DAY_MS });
    assert.equal(restored.sweep.restored, 1);
    assert.deepEqual(yield* trashNames(root), []);
    assert.equal((yield* promise(() => lstat(original))).ino, inode);
    assert.equal(yield* promise(() => readFile(original, "utf8")), "restore me");

    const later = yield* maintenance.runTick({ nowMs: START_MS + 30 * DAY_MS });
    assert.equal(later.sweep.trashed + later.sweep.deleted, 0);
    assert.isTrue(existsSync(original));
  }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);

it.effect("finishes a restore interrupted between link and unlink, and never clobbers", () =>
  Effect.gen(function* () {
    const { attachmentsDir: root } = yield* ServerConfig;
    const maintenance = yield* AttachmentMaintenance;
    yield* seedThread(THREAD_ID);
    const halfway = `${attachmentIdFor(THREAD_ID, 20)}.png`;
    const occupied = `${attachmentIdFor(THREAD_ID, 21)}.png`;
    const trash = path.join(root, ".trash");
    yield* promise(() => mkdir(trash));
    const halfwayTrash = yield* promise(() =>
      writeAttachmentFile(trash, `${START_MS - DAY_MS}__${halfway}`, "halfway"),
    );
    yield* promise(() => link(halfwayTrash, path.join(root, halfway)));
    yield* promise(() => writeAttachmentFile(trash, `${START_MS - DAY_MS}__${occupied}`, "old"));
    yield* promise(() => writeFile(path.join(root, occupied), "newer file"));
    yield* referenceAttachment(THREAD_ID, "message-halfway", attachmentIdFor(THREAD_ID, 20));
    yield* referenceAttachment(THREAD_ID, "message-occupied", attachmentIdFor(THREAD_ID, 21));

    const result = yield* maintenance.runTick({ nowMs: START_MS + 30 * DAY_MS });
    assert.equal(result.sweep.restored, 1);
    assert.equal(result.sweep.deleted, 0, "a referenced trash entry is never deleted");
    assert.deepEqual(yield* trashNames(root), [`${START_MS - DAY_MS}__${occupied}`]);
    assert.equal(yield* promise(() => readFile(path.join(root, halfway), "utf8")), "halfway");
    assert.equal(yield* promise(() => readFile(path.join(root, occupied), "utf8")), "newer file");
  }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);

it.effect("trashes at most 50 files per tick and reports the rest as backlog", () =>
  Effect.gen(function* () {
    const { attachmentsDir: root } = yield* ServerConfig;
    const maintenance = yield* AttachmentMaintenance;
    for (let n = 100; n < 160; n += 1) {
      yield* promise(() => writeAttachmentFile(root, `${attachmentIdFor(THREAD_ID, n)}.png`, "x"));
    }
    const first = yield* maintenance.runTick({ nowMs: START_MS });
    assert.equal(first.sweep.trashed, 50);
    assert.isAtLeast(first.backlog, 10);
    const second = yield* maintenance.runTick({ nowMs: START_MS });
    assert.equal(second.sweep.trashed, 10);
    assert.equal(second.backlog, 0);
    assert.lengthOf(yield* trashNames(root), 60);
  }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);

it.effect("skips a tick while another is in flight", () =>
  Effect.gen(function* () {
    const maintenance = yield* AttachmentMaintenance;
    const [left, right] = yield* Effect.all(
      [maintenance.runTick({ nowMs: START_MS }), maintenance.runTick({ nowMs: START_MS })],
      { concurrency: 2 },
    );
    assert.sameMembers([left.status, right.status], ["completed", "skipped-in-flight"]);
  }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);
