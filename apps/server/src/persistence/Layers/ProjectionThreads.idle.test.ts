import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { makeListIdleThreadCandidates } from "./ProjectionThreads.idle.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const OLD = "2026-10-30T00:00:00.000Z";
const RECENT = "2026-10-30T00:59:00.000Z";
const CUTOFF = "2026-10-30T00:30:00.000Z";

/** Inserts a row, filling required columns the test does not care about with placeholders. */
const insertRow = (table: string, values: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{
      readonly name: string;
      readonly type: string;
      readonly notnull: number;
      readonly dflt_value: unknown;
      readonly pk: number;
    }>`SELECT * FROM pragma_table_info(${table})`;
    const row: Record<string, unknown> = { ...values };
    for (const column of columns) {
      if (column.name in row || column.notnull === 0 || column.dflt_value !== null) continue;
      row[column.name] = /INT|REAL|NUM/i.test(column.type)
        ? 0
        : `${column.name}-${Math.random().toString(36).slice(2)}`;
    }
    const names = Object.keys(row);
    yield* sql.unsafe(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      names.map((name) => row[name]),
    );
  });

const thread = (threadId: string, overrides: Record<string, unknown> = {}) =>
  insertRow("projection_threads", {
    thread_id: threadId,
    project_id: "project",
    title: threadId,
    model_selection_json: '{"provider":"codex","model":"gpt-5-codex"}',
    runtime_mode: "full-access",
    created_at: OLD,
    updated_at: OLD,
    last_activity_at: OLD,
    deleted_at: null,
    latest_turn_id: null,
    ...overrides,
  });

layer("Inyosira idle candidates", (it) => {
  it.effect("returns only quiet, quiescent threads in the asked states; each gate excludes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // Counterparts of the delegation and watch below; never candidates themselves.
      yield* thread("child-elsewhere", { organization_state: "done" });
      yield* thread("watched-elsewhere", { organization_state: "done" });
      yield* thread("idle-a");
      yield* thread("idle-b", { last_activity_at: "2026-10-30T00:10:00.000Z" });
      // Only the older-threads rule asks for Later; a snoozed Later thread is never a candidate.
      yield* thread("later-quiet", { organization_state: "later" });
      // Organization and lifecycle gates.
      yield* thread("recent", { last_activity_at: RECENT });
      yield* thread("refreshed", { organization_changed_at: RECENT });
      yield* thread("done", { organization_state: "done" });
      yield* thread("snoozed", {
        organization_state: "later",
        organization_snooze_id: "s",
        organization_snooze_until: RECENT,
      });
      yield* thread("archived", { archived_at: OLD });
      yield* thread("deleting", { deleting_at: OLD });
      // Runtime gates on the thread row.
      yield* thread("queued", { queued_prompts_json: '[{"id":"m"}]' });
      yield* thread("held", { queue_hold: 1 });
      yield* thread("starting", { pending_turn_start_json: "{}" });
      yield* thread("controlling", { pending_turn_control_operation_json: "{}" });
      yield* thread("flushing", { pending_interrupt_flush_intent_json: "{}" });
      yield* thread("recovering", { recovery_json: "{}" });
      // Runtime and attention gates in other projections.
      yield* thread("session-running");
      yield* insertRow("projection_thread_sessions", {
        thread_id: "session-running",
        status: "running",
        updated_at: OLD,
      });
      yield* thread("turn-running", { latest_turn_id: "turn-1" });
      yield* insertRow("projection_turns", {
        thread_id: "turn-running",
        turn_id: "turn-1",
        state: "running",
        requested_at: OLD,
      });
      yield* thread("approval");
      yield* insertRow("projection_pending_approvals", {
        request_id: "approval-1",
        thread_id: "approval",
        status: "pending",
        created_at: OLD,
      });
      yield* thread("question");
      yield* insertRow("projection_pending_user_inputs", {
        request_id: "input-1",
        thread_id: "question",
        status: "pending",
        created_at: OLD,
      });
      yield* thread("delegating");
      yield* insertRow("thread_delegations", {
        caller_thread_id: "delegating",
        child_thread_id: "child-elsewhere",
        state: "running",
      });
      yield* thread("watching");
      yield* insertRow("projection_thread_watches", {
        watcher_thread_id: "watching",
        watched_thread_id: "watched-elsewhere",
        status: "active",
      });

      // Provider runtime gates: an unfinished Codex rewind or unacknowledged inspection blocks;
      // an ordinary runtime row does not.
      const runtime = (threadId: string, payload: unknown) =>
        insertRow("provider_session_runtime", {
          thread_id: threadId,
          provider_name: "codex",
          runtime_payload_json: JSON.stringify(payload),
        });
      yield* thread("runtime-clean");
      yield* runtime("runtime-clean", { sessionEpoch: 1 });
      yield* thread("rewinding");
      yield* runtime("rewinding", { "bigbud.codex.rewind": { operationId: "op", stage: "x" } });
      yield* thread("inspecting");
      yield* runtime("inspecting", {
        "bigbud.codex.inspectionTerminal": { version: 1, acknowledgements: { ingestion: true } },
      });

      const list = makeListIdleThreadCandidates(sql);
      const present = yield* list({ states: ["present"], cutoff: CUTOFF, limit: 50 });
      assert.deepStrictEqual(
        present.map((candidate) => candidate.threadId),
        ["idle-a", "runtime-clean", "idle-b"],
      );
      assert.deepStrictEqual(present[2], {
        threadId: "idle-b",
        state: "present",
        revision: 0,
        activityAt: "2026-10-30T00:10:00.000Z",
      });
      const older = yield* list({ states: ["present", "later"], cutoff: CUTOFF, limit: 50 });
      assert.deepStrictEqual(
        older.map((candidate) => [candidate.threadId, candidate.state]),
        [
          ["idle-a", "present"],
          ["later-quiet", "later"],
          ["runtime-clean", "present"],
          ["idle-b", "present"],
        ],
      );
      assert.equal((yield* list({ states: ["present"], cutoff: CUTOFF, limit: 1 })).length, 1);
    }),
  );
});
