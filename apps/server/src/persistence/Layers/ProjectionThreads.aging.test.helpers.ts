import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";

export const OLD = "2026-10-01T00:00:00.000Z";
export const RECENT = "2026-11-05T00:00:00.000Z";
export const ageThread = (id: string, revision = 1) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertProjectionThreadParent({ sql, threadId: ThreadId.makeUnsafe(id), createdAt: OLD });
    yield* sql`UPDATE projection_threads SET last_activity_at = ${OLD},
    organization_revision = ${revision}, organization_changed_at = ${RECENT}
    WHERE thread_id = ${id}`;
  });

export const ageEvent = (
  id: string,
  revision: number,
  input: {
    changedAt?: string;
    reason?: string;
    source?: string;
    malformed?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = input.malformed
      ? "{"
      : JSON.stringify({
          threadId: id,
          organization: {
            state: "later",
            revision,
            changedAt: input.changedAt ?? RECENT,
            snooze: null,
          },
          reason: input.reason ?? "idle",
          ...(input.source ? { source: input.source } : {}),
        });
    yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id,
    stream_version, event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json)
    VALUES (${`${id}:${revision}`}, 'thread', ${id}, ${revision}, 'thread.organization-updated',
      ${RECENT}, ${`${id}:${revision}`}, 'system', ${payload}, '{}')`;
  });

export const ageRow = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ anchor: string | null; provenance: string }>`SELECT
    organization_activity_at AS anchor, organization_age_provenance AS provenance
    FROM projection_threads WHERE thread_id = ${id}`;
    return row;
  });
