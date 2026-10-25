import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";
import { makeGetUsageEntries } from "../../orchestration/Layers/ProjectionSnapshotQuery.usage.ts";

it.layer(SqlitePersistenceMemory)("historical usage attribution", (it) => {
  it.effect("recovers only exact, unambiguous requests and preserves unattributed totals", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("historical-attribution");
      const requestedAt = "2026-10-01T00:00:00.000Z";
      yield* insertProjectionThreadParent({ sql, threadId });
      // These are deliberately unrelated to the historical requests below.
      yield* sql`UPDATE projection_threads SET model_selection_json = ${JSON.stringify({ provider: "claude", model: "current-model" })}
        WHERE thread_id = ${threadId}`;
      const cases = [
        {
          id: "selection",
          payload: { modelSelection: { provider: "codex", model: "old-model" } },
          provider: "codex",
          model: "old-model",
        },
        {
          id: "frozen",
          payload: {
            usageAttribution: {
              provider: "cursor",
              model: "frozen-model",
              interactionMode: "default",
            },
          },
          provider: "cursor",
          model: "frozen-model",
        },
        { id: "missing", payload: {}, provider: "unknown", model: "unknown" },
        {
          id: "no-selection",
          payload: { interactionMode: "default" },
          provider: "unknown",
          model: "unknown",
        },
        {
          id: "ambiguous",
          payload: { modelSelection: { provider: "codex", model: "ambiguous-model" } },
          provider: "unknown",
          model: "unknown",
        },
        {
          id: "wrong-time",
          payload: {
            createdAt: "2026-10-02T00:00:00.000Z",
            modelSelection: { provider: "codex", model: "wrong-model" },
          },
          provider: "unknown",
          model: "unknown",
        },
        {
          id: "wrong-message",
          payload: {
            messageId: "other-message",
            modelSelection: { provider: "codex", model: "wrong-model" },
          },
          provider: "unknown",
          model: "unknown",
        },
      ];
      let sequence = 0;
      for (const entry of cases) {
        yield* sql`INSERT INTO projection_turns
          (thread_id, turn_id, pending_message_id, state, requested_at, started_at, checkpoint_files_json)
          VALUES (${threadId}, ${entry.id}, ${entry.id}, 'completed', ${requestedAt}, ${requestedAt}, '[]')`;
        yield* sql`INSERT INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at, observable_token_count, observable_estimator_version)
          VALUES (${entry.id}, ${threadId}, ${entry.id}, 'user', 'text', 0, ${requestedAt}, ${requestedAt}, 1, 'observable-text-v1')`;
        if (entry.id === "missing") continue;
        const copies = entry.id === "ambiguous" ? 2 : 1;
        for (let copy = 0; copy < copies; copy++) {
          sequence++;
          yield* sql`INSERT INTO orchestration_events
            (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
            VALUES (${`request-${sequence}`}, 'thread', ${threadId}, ${sequence}, 'thread.turn-start-requested',
              ${requestedAt}, 'user', ${JSON.stringify({ threadId, messageId: entry.id, createdAt: requestedAt, ...entry.payload })}, '{}')`;
        }
      }
      const query = makeGetUsageEntries(sql);
      const rows = yield* query(null);
      assert.equal(rows.length, cases.length);
      assert.equal(
        rows.reduce((total, row) => total + row.usedTokens, 0),
        cases.length,
      );
      for (const entry of cases) {
        const row = rows.find((row) => row.turnId === entry.id)!;
        assert.equal(row.provider, entry.provider);
        assert.equal(row.model, entry.model);
        assert.equal(row.source, "estimated");
      }
      // Frozen turn attribution wins over a request, and changing today's settings has no effect.
      yield* sql`UPDATE projection_turns SET usage_provider = 'copilot', usage_model = 'projected-model'
        WHERE thread_id = ${threadId} AND turn_id = 'selection'`;
      const projected = (yield* query(null)).find((row) => row.turnId === "selection")!;
      assert.equal(projected.provider, "copilot");
      assert.equal(projected.model, "projected-model");
      assert.equal((yield* query("2026-10-02T00:00:00.000Z")).length, 0);
      yield* sql`INSERT INTO projection_usage_contributions
        (contribution_id, activity_id, thread_id, turn_id, provider, model, interaction_mode,
          occurred_at, used_tokens, input_tokens, cached_input_tokens, output_tokens,
          reasoning_output_tokens, finalized, updated_at)
        VALUES ('official', 'activity', ${threadId}, 'frozen', 'unknown', 'unknown', 'default',
          ${requestedAt}, 0, 0, 0, 0, 0, 1, ${requestedAt})`;
      const officialRows = yield* query(null);
      assert.equal(officialRows.length, cases.length);
      assert.equal(
        officialRows.reduce((total, row) => total + row.usedTokens, 0),
        cases.length - 1,
      );
      const official = officialRows.find((row) => row.turnId === "frozen")!;
      assert.equal(official.source, "provider-reported");
      assert.equal(official.provider, "cursor");
      assert.equal(official.model, "frozen-model");
      // Actual provider evidence must not be paired with another provider's requested model.
      yield* sql`UPDATE projection_usage_contributions SET provider = 'codex' WHERE contribution_id = 'official'`;
      const differentProvider = (yield* query(null)).find((row) => row.turnId === "frozen")!;
      assert.equal(differentProvider.provider, "codex");
      assert.equal(differentProvider.model, "unknown");
    }),
  );
});
