import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Effect, Exit, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { managedRelativePath } from "../deletion/Layers/EntityPurge.resources.ts";
import { parseAttachmentIdFromRelativePath } from "./attachmentStore.ts";

const STAGED_RECONCILIATION_DELAY_MS = 5 * 60_000;
const STAGED_RECONCILIATION_BATCH_SIZE = 25;

async function verifiedIdentity(input: {
  readonly attachmentsDir: string;
  readonly destination: string;
  readonly contentSha256: string;
  readonly sizeBytes: number;
}) {
  const root = await lstat(input.attachmentsDir, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("attachment_root_invalid");
  const identity = await lstat(input.destination, { bigint: true });
  if (!identity.isFile() || identity.size !== BigInt(input.sizeBytes)) {
    throw new Error("file_identity_invalid");
  }
  const bytes = await readFile(input.destination);
  if (createHash("sha256").update(bytes).digest("hex") !== input.contentSha256) {
    throw new Error("content_mismatch");
  }
  const afterRead = await lstat(input.destination, { bigint: true });
  if (
    afterRead.dev !== identity.dev ||
    afterRead.ino !== identity.ino ||
    afterRead.size !== identity.size
  ) {
    throw new Error("file_identity_changed");
  }
  return identity;
}

/** Reconcile only durable staged records; an invalid record never grants deletion authority. */
export const reconcileStagedManagedAttachments = Effect.fn("reconcileStagedManagedAttachments")(
  function* (attachmentsDir: string, now = new Date()) {
    const sql = yield* SqlClient.SqlClient;
    const cutoff = new Date(now.getTime() - STAGED_RECONCILIATION_DELAY_MS).toISOString();
    const rows = yield* sql<{
      attachmentId: string;
      relativePath: string;
      contentSha256: string;
      sizeBytes: number;
    }>`
      SELECT attachment_id AS "attachmentId", relative_path AS "relativePath",
        content_sha256 AS "contentSha256", size_bytes AS "sizeBytes"
      FROM managed_attachment_ownership
      WHERE lifecycle = 'staged' AND created_at <= ${cutoff}
      ORDER BY created_at, attachment_id LIMIT ${STAGED_RECONCILIATION_BATCH_SIZE}
    `;
    for (const row of rows) {
      const destination = resolve(attachmentsDir, row.relativePath);
      const validPath =
        parseAttachmentIdFromRelativePath(row.relativePath) === row.attachmentId &&
        managedRelativePath(attachmentsDir, destination) === row.relativePath;
      const outcome = validPath
        ? yield* Effect.tryPromise(() =>
            verifiedIdentity({
              attachmentsDir,
              destination,
              contentSha256: row.contentSha256,
              sizeBytes: row.sizeBytes,
            }),
          ).pipe(Effect.exit)
        : null;
      if (outcome && Exit.isSuccess(outcome)) {
        yield* sql`
          UPDATE managed_attachment_ownership SET lifecycle = 'published',
            file_device = ${outcome.value.dev.toString()}, file_id = ${outcome.value.ino.toString()},
            published_at = ${now.toISOString()}
          WHERE attachment_id = ${row.attachmentId} AND lifecycle = 'staged'
            AND relative_path = ${row.relativePath} AND content_sha256 = ${row.contentSha256}
        `;
      } else {
        const reason = validPath ? "staged_file_unverified" : "staged_path_invalid";
        yield* sql`
          UPDATE managed_attachment_ownership SET lifecycle = 'blocked',
            blocked_at = ${now.toISOString()}, blocked_reason = ${reason}
          WHERE attachment_id = ${row.attachmentId} AND lifecycle = 'staged'
            AND relative_path = ${row.relativePath} AND content_sha256 = ${row.contentSha256}
        `;
      }
    }
    return rows.length;
  },
);

/** A staged record alone never grants deletion authority. */
export const persistManagedAttachment = Effect.fn("persistManagedAttachment")(function* <
  E,
  R,
>(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
  readonly creatorThreadId: string;
  readonly destination: string;
  readonly bytes: Uint8Array;
  readonly write: Effect.Effect<boolean, E, R>;
}) {
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sqlOption)) {
    yield* input.write;
    return;
  }
  const sql = sqlOption.value;
  const relativePath = managedRelativePath(input.attachmentsDir, input.destination);
  if (!relativePath) return yield* Effect.fail(new Error("Unsafe managed attachment path"));
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  const now = new Date().toISOString();
  yield* sql`
    INSERT INTO managed_attachment_ownership (
      attachment_id, relative_path, creator_thread_id, content_sha256,
      size_bytes, lifecycle, created_at
    ) VALUES (${input.attachmentId}, ${relativePath}, ${input.creatorThreadId},
      ${digest}, ${input.bytes.byteLength}, 'staged', ${now})
    ON CONFLICT DO NOTHING
  `;
  const rows = yield* sql<{
    relativePath: string;
    creatorThreadId: string;
    contentSha256: string;
    sizeBytes: number;
    lifecycle: string;
  }>`
    SELECT relative_path AS "relativePath", creator_thread_id AS "creatorThreadId",
      content_sha256 AS "contentSha256", size_bytes AS "sizeBytes", lifecycle
    FROM managed_attachment_ownership WHERE attachment_id = ${input.attachmentId}
  `;
  const ownership = rows[0];
  if (
    !ownership ||
    ownership.relativePath !== relativePath ||
    ownership.creatorThreadId !== input.creatorThreadId ||
    ownership.contentSha256 !== digest ||
    ownership.sizeBytes !== input.bytes.byteLength ||
    ownership.lifecycle === "blocked"
  ) {
    return yield* Effect.fail(new Error("Managed attachment ownership conflict"));
  }
  yield* input.write;
  const identity = yield* Effect.tryPromise(() =>
    verifiedIdentity({
      attachmentsDir: input.attachmentsDir,
      destination: input.destination,
      contentSha256: digest,
      sizeBytes: input.bytes.byteLength,
    }),
  );
  yield* sql`
    UPDATE managed_attachment_ownership SET lifecycle = 'published',
      file_device = ${identity.dev.toString()}, file_id = ${identity.ino.toString()},
      published_at = ${new Date().toISOString()}
    WHERE attachment_id = ${input.attachmentId} AND lifecycle = 'staged'
      AND relative_path = ${relativePath} AND content_sha256 = ${digest}
  `;
});
