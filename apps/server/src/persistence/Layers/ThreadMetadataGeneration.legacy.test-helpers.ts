import { CommandId, EventId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { calculateCommandPayloadDigest } from "../../orchestration/commandDigest.ts";

export const at = "2026-11-09T10:00:00.000Z";
export const seedThread = Effect.fn("seedLegacyMetadataThread")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (
    project_id, title, workspace_root, scripts_json, created_at, updated_at
  ) VALUES (${id}, 'Legacy', '/tmp/legacy', '[]', ${at}, ${at})`;
  yield* sql`INSERT INTO projection_threads (
    thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
    queued_prompts_json, created_at, updated_at, last_activity_at
  ) VALUES (${id}, ${id}, 'Legacy', '{"provider":"codex","model":"verified"}',
    'full-access', 'default', '[]', ${at}, ${at}, ${at})`;
  return ThreadId.makeUnsafe(id);
});
export const seedActivity = Effect.fn("seedLegacyMetadataActivity")(function* (
  threadId: ThreadId,
  id: string,
  kind = "text-generation.title-stage",
  payload: unknown = { stage: 1, state: "started", owner: "original" },
  includeReceipt = true,
) {
  const sql = yield* SqlClient.SqlClient;
  const command = {
    type: "thread.activity.append" as const,
    commandId: CommandId.makeUnsafe(`server:${id}`),
    threadId,
    createdAt: at,
    activity: {
      id: EventId.makeUnsafe(id),
      tone: "info" as const,
      kind,
      summary: "Legacy metadata evidence",
      payload,
      turnId: null,
      createdAt: at,
    },
  };
  const digest = calculateCommandPayloadDigest(command);
  const [event] = yield* sql<{ sequence: number }>`INSERT INTO orchestration_events (
    event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
    command_id, actor_kind, payload_json, metadata_json
  ) VALUES (${id}, 'thread', ${threadId},
    (SELECT COALESCE(MAX(stream_version), 0) + 1 FROM orchestration_events WHERE stream_id = ${threadId}),
    'thread.activity-appended', ${at}, ${command.commandId}, 'server',
    ${JSON.stringify({ threadId, activity: command.activity })}, '{}') RETURNING sequence`;
  yield* sql`INSERT INTO projection_thread_activities (
    activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
  ) VALUES (${id}, ${threadId}, NULL, 'info', ${kind}, ${command.activity.summary},
    ${JSON.stringify(payload)}, NULL, ${at})`;
  if (includeReceipt)
    yield* sql`INSERT INTO orchestration_command_receipts (
    command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status,
    payload_digest_version, payload_digest
  ) VALUES (${command.commandId}, 'thread', ${threadId}, ${at}, ${event!.sequence}, 'accepted',
    ${digest.version}, ${digest.digest})`;
  return command;
});
