import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";
import { AttachmentMaintenanceLive } from "./AttachmentMaintenance.ts";

export const DAY_MS = 24 * 60 * 60 * 1_000;
export const THREAD_ID = "thread-11111111-1111-4111-8111-111111111111";
export const OTHER_THREAD_ID = "thread-22222222-2222-4222-8222-222222222222";

/** Fresh in-memory database and temporary state directory for every test. */
export const makeAttachmentMaintenanceTestLayer = () =>
  AttachmentMaintenanceLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistenceMemory,
        ServerConfig.layerTest(process.cwd(), { prefix: "attachment-maintenance-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

/** A managed attachment ID for `threadId`; `n` picks a distinct UUID. */
export const attachmentIdFor = (threadId: string, n: number) =>
  `${threadId}-${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

const at = "2026-09-01T00:00:00.000Z";

export const seedThread = Effect.fn("test.seedThread")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Project', '/project', '[]', ${at}, ${at})`;
  yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      created_at, updated_at)
    VALUES (${threadId}, 'project', ${threadId}, '{"provider":"codex","model":"test"}',
      'full-access', 'default', ${at}, ${at})`;
});

/** A user message that references `attachmentId`; triggers write both reference tables. */
export const referenceAttachment = Effect.fn("test.referenceAttachment")(function* (
  threadId: string,
  messageId: string,
  attachmentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const attachments = JSON.stringify([
    { type: "image", id: attachmentId, name: "image.png", mimeType: "image/png", sizeBytes: 3 },
  ]);
  yield* sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at)
    VALUES (${messageId}, ${threadId}, 'user', 'image', ${attachments}, 0, ${at}, ${at})`;
});

/** Writes a file and backdates its mtime; ctime stays at the real time of the write. */
export async function writeAttachmentFile(
  root: string,
  fileName: string,
  content: string,
  mtimeMs?: number,
): Promise<string> {
  const filePath = path.join(root, fileName);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  if (mtimeMs !== undefined) await utimes(filePath, mtimeMs / 1_000, mtimeMs / 1_000);
  return filePath;
}
