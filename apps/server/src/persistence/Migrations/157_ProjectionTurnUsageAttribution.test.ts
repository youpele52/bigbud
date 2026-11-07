import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { makeGetUsageEntries } from "../../orchestration/Layers/ProjectionSnapshotQuery.usage.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";
import migration from "./157_ProjectionTurnUsageAttribution.ts";
import { THREAD_REQUESTS_SQL } from "./157_ProjectionTurnUsageAttribution.requests.ts";

const DATE = "2026-09-01T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("legacy-usage-thread");

interface TurnFixture {
  readonly turnId: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly mode?: string | null;
  /** Payloads of the turn's `thread.turn-start-requested` events. */
  readonly requests: ReadonlyArray<string>;
}

const request = (turnId: string, extra: Record<string, unknown>) =>
  JSON.stringify({ threadId, messageId: `prompt-${turnId}`, createdAt: DATE, ...extra });

const TURNS: ReadonlyArray<TurnFixture> = [
  {
    turnId: "attributed-request",
    provider: null,
    model: null,
    requests: [
      request("attributed-request", {
        usageAttribution: { provider: "claudeAgent", model: "opus", interactionMode: "plan" },
        modelSelection: { provider: "codex", model: "ignored" },
        interactionMode: "plan",
      }),
    ],
  },
  {
    turnId: "model-selection-request",
    provider: "unknown",
    model: "unknown",
    requests: [
      request("model-selection-request", {
        modelSelection: { provider: "codex", model: "gpt-5" },
        interactionMode: "default",
      }),
    ],
  },
  {
    // Projected with part of its attribution; the request completes it without overriding it.
    turnId: "partially-projected",
    provider: "codex",
    model: null,
    mode: "default",
    requests: [
      request("partially-projected", {
        modelSelection: { provider: "copilot", model: "from-request" },
        interactionMode: "plan",
      }),
    ],
  },
  {
    turnId: "known",
    provider: "copilot",
    model: "kept",
    mode: "default",
    requests: [request("known", { modelSelection: { provider: "codex", model: "other" } })],
  },
  {
    turnId: "ambiguous",
    provider: null,
    model: null,
    requests: [
      request("ambiguous", { modelSelection: { provider: "codex", model: "a" } }),
      request("ambiguous", { modelSelection: { provider: "codex", model: "b" } }),
    ],
  },
  { turnId: "malformed", provider: null, model: null, requests: ["{malformed"] },
];

const EXPECTED: Record<string, readonly [string, string, string]> = {
  "attributed-request": ["claudeAgent", "opus", "plan"],
  "model-selection-request": ["codex", "gpt-5", "default"],
  "partially-projected": ["codex", "from-request", "default"],
  known: ["copilot", "kept", "default"],
  ambiguous: ["unknown", "unknown", "unknown"],
  malformed: ["unknown", "unknown", "unknown"],
};

const seedLegacyTurns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* insertProjectionThreadParent({ sql, threadId });
  let version = 0;
  for (const turn of TURNS) {
    yield* sql`INSERT INTO projection_turns
      (thread_id, turn_id, pending_message_id, state, requested_at, started_at,
        checkpoint_files_json, usage_provider, usage_model, usage_interaction_mode)
      VALUES (${threadId}, ${turn.turnId}, ${`prompt-${turn.turnId}`}, 'completed', ${DATE},
        ${DATE}, '[]', ${turn.provider}, ${turn.model}, ${turn.mode ?? null})`;
    yield* sql`INSERT INTO projection_thread_messages
      (thread_id, message_id, turn_id, role, text, is_streaming, created_at, updated_at,
        observable_token_count, observable_estimator_version)
      VALUES (${threadId}, ${`prompt-${turn.turnId}`}, ${turn.turnId}, 'user', '', 0, ${DATE},
        ${DATE}, 3, 'observable-text-v1'),
      (${threadId}, ${`answer-${turn.turnId}`}, ${turn.turnId}, 'assistant', '', 0, ${DATE},
        ${DATE}, 5, 'observable-text-v1')`;
    for (const payload of turn.requests) {
      version += 1;
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json)
        VALUES (${`request-${version}`}, 'thread', ${threadId}, ${version},
          'thread.turn-start-requested', ${DATE}, 'user', ${payload}, '{}')`;
    }
  }
});

const readAttribution = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const entries = yield* makeGetUsageEntries(sql)(null);
  return Object.fromEntries(
    entries.map((entry) => [
      entry.turnId ?? "",
      [entry.provider, entry.model, entry.interactionMode] as const,
    ]),
  );
});

const readSources = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly turnId: string; readonly source: string | null }>`
    SELECT turn_id AS "turnId", usage_attribution_source AS source FROM projection_turns
  `;
  return Object.fromEntries(rows.map((row) => [row.turnId, row.source]));
});

/**
 * A turn left with complete attribution is recorded as `backfill`, including one the request only
 * completes. A turn already known, or whose request is ambiguous or unreadable, keeps NULL.
 */
const EXPECTED_SOURCES: Record<string, string | null> = {
  "attributed-request": "backfill",
  "model-selection-request": "backfill",
  "partially-projected": "backfill",
  known: null,
  ambiguous: null,
  malformed: null,
};

it.effect(
  "persists legacy turn attribution so usage survives compaction of the request events",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 156 });
      yield* seedLegacyTurns;
      yield* runMigrations();
      assert.deepEqual(yield* readAttribution, EXPECTED);
      assert.deepEqual(yield* readSources, EXPECTED_SOURCES);

      // Idempotent while the source events still exist: nothing is filled or re-marked twice.
      yield* migration;
      assert.deepEqual(yield* readAttribution, EXPECTED);
      assert.deepEqual(yield* readSources, EXPECTED_SOURCES);

      // Compaction removes every raw request below the hot window; usage is unchanged.
      yield* sql`DELETE FROM orchestration_events`;
      assert.deepEqual(yield* readAttribution, EXPECTED);
      yield* migration;
      assert.deepEqual(yield* readAttribution, EXPECTED);
      assert.deepEqual(yield* readSources, EXPECTED_SOURCES);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("reads the requests of each staged thread by stream index", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${THREAD_REQUESTS_SQL}`,
      [threadId, 0, 1],
    );
    assert.ok(plan.some(({ detail }) => detail.includes("idx_orch_events_stream_sequence")));
    assert.ok(!plan.some(({ detail }) => /^SCAN (e|orchestration_events)\b/.test(detail)));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
