import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../startup/config.ts";
import { AttachmentMaintenance } from "../Services/AttachmentMaintenance.ts";
import { loadAttachmentHolds } from "./AttachmentMaintenance.holds.ts";
import { runAttachmentOrphanScan } from "./AttachmentMaintenance.sweep.ts";
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

const image = (id: string) => ({
  type: "image",
  id,
  name: "image.png",
  mimeType: "image/png",
  sizeBytes: 3,
});

const file = (n: number) => ({
  attachmentId: attachmentIdFor(THREAD_ID, n),
  fileName: `${attachmentIdFor(THREAD_ID, n)}.png`,
});

it.effect("holds attachments of queued prompts and of a pending turn start's message", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { attachmentsDir: root } = yield* ServerConfig;
    const maintenance = yield* AttachmentMaintenance;
    yield* seedThread(THREAD_ID);
    yield* seedThread(OTHER_THREAD_ID);
    const queued = file(1);
    const pending = file(2);
    const orphan = file(3);
    for (const entry of [queued, pending, orphan]) {
      yield* promise(() => writeAttachmentFile(root, entry.fileName, entry.fileName));
    }
    const prompts = JSON.stringify([
      { id: "queued-1", text: "later", createdAt: "2026-09-01T00:00:00.000Z" },
      {
        id: "queued-2",
        text: "with image",
        createdAt: "2026-09-01T00:00:00.000Z",
        attachments: [image(queued.attachmentId), "not-an-object"],
      },
      "not-a-prompt",
    ]);
    yield* sql`UPDATE projection_threads SET queued_prompts_json = ${prompts}
      WHERE thread_id = ${THREAD_ID}`;
    // Malformed JSON elsewhere must not break the query for everyone.
    yield* sql`UPDATE projection_threads SET queued_prompts_json = '[{broken',
      pending_turn_start_json = '{broken' WHERE thread_id = ${OTHER_THREAD_ID}`;
    // The pending start's message: only the gate holds it once its reference rows are gone.
    yield* referenceAttachment(THREAD_ID, "message-pending", pending.attachmentId);
    yield* sql`DELETE FROM projection_thread_attachment_refs WHERE attachment_id = ${pending.attachmentId}`;
    yield* sql`DELETE FROM managed_attachment_references WHERE attachment_id = ${pending.attachmentId}`;
    yield* sql`UPDATE projection_threads SET pending_turn_start_json =
      ${JSON.stringify({ messageId: "message-pending", requestedAt: "2026-09-01T00:00:00.000Z" })}
      WHERE thread_id = ${THREAD_ID}`;

    const holds = yield* loadAttachmentHolds(sql, [queued, pending, orphan]);
    assert.equal(holds.get(queued.fileName), "referenced");
    assert.equal(holds.get(pending.fileName), "referenced");
    assert.isUndefined(holds.get(orphan.fileName));

    const tick = yield* maintenance.runTick({ nowMs: START_MS });
    assert.equal(tick.sweep.trashed, 1);
    assert.isTrue(existsSync(path.join(root, queued.fileName)));
    assert.isTrue(existsSync(path.join(root, pending.fileName)));
    assert.isFalse(existsSync(path.join(root, orphan.fileName)));

    // Once the queue drains and the turn binds, nothing holds them any more.
    yield* sql`UPDATE projection_threads SET queued_prompts_json = '[]',
      pending_turn_start_json = NULL WHERE thread_id = ${THREAD_ID}`;
    const released = yield* loadAttachmentHolds(sql, [queued, pending]);
    assert.equal(released.size, 0);
  }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);

it.effect("restores a file at once when a reference lands while it moves to the trash", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { attachmentsDir: root } = yield* ServerConfig;
    yield* seedThread(THREAD_ID);
    const raced = file(1);
    const orphan = file(2);
    for (const entry of [raced, orphan]) {
      yield* promise(() => writeAttachmentFile(root, entry.fileName, entry.fileName));
    }
    const moved: Array<string> = [];
    const result = yield* runAttachmentOrphanScan(
      {
        sql,
        root,
        nowMs: START_MS,
        deadlineReached: () => false,
        fileOps: { remaining: 50 },
        // The reference commits after the final pre-move check, while the file is in the trash.
        afterTrashMove: (entry) =>
          Effect.gen(function* () {
            moved.push(entry.fileName);
            if (entry.fileName === raced.fileName) {
              yield* referenceAttachment(THREAD_ID, "message-raced", raced.attachmentId).pipe(
                Effect.orDie,
              );
            }
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      },
      { cursor: "" },
      [raced, orphan],
    );
    assert.deepEqual(moved, [raced.fileName, orphan.fileName]);
    assert.equal(result.trashed, 1);
    assert.isTrue(existsSync(path.join(root, raced.fileName)));
    assert.isFalse(existsSync(path.join(root, orphan.fileName)));
    const trash = yield* promise(() => readdir(path.join(root, ".trash")));
    assert.deepEqual(trash, [`${Math.floor(START_MS)}__${orphan.fileName}`]);
  }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);
