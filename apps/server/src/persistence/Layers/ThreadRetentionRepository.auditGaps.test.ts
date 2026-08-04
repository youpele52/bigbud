import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadRetentionRepository } from "../Services/ThreadRetentionRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "./ThreadRetentionRepository.ts";

const OLD = "2026-01-01T00:00:00.000Z";
const CUTOFF = "2026-02-01T00:00:00.000Z";
const NOW = "2026-03-01T00:00:00.000Z";
const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const reset = Effect.fn("resetRetentionAuditGapData")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM thread_activity_leases`;
  yield* sql`DELETE FROM worktree_runtime_leases`;
  yield* sql`DELETE FROM thread_retention_run_items`;
  yield* sql`DELETE FROM thread_retention_runs`;
  yield* sql`DELETE FROM checkpoint_diff_blobs`;
  yield* sql`DELETE FROM projection_thread_activities`;
  yield* sql`DELETE FROM projection_thread_messages`;
  yield* sql`DELETE FROM projection_turns`;
  yield* sql`DELETE FROM projection_thread_sessions`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, provider_runtime_execution_target_id,
      workspace_execution_target_id, execution_target_id, workspace_root,
      scripts_json, created_at, updated_at
    ) VALUES ('audit-project', 'Audit', 'local', 'local', 'local', '/tmp/audit', '[]', ${OLD}, ${OLD})
  `;
});

const seedThread = Effect.fn("seedRetentionAuditThread")(function* (
  threadId: string,
  options: { readonly archived?: boolean; readonly worktree?: boolean } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, purpose, elevator_summary,
      elevator_summary_message_count, provider_runtime_execution_target_id,
      workspace_execution_target_id, execution_target_id, model_selection_json,
      runtime_mode, interaction_mode, queued_prompts_json, created_at, updated_at,
      last_activity_at, worktree_path, archived_at
    ) VALUES (${threadId}, 'audit-project', ${threadId}, 'standard', ${threadId}, 0,
      'local', 'local', 'local', '{"provider":"codex","model":"gpt-5.4"}',
      'full-access', 'default', '[]', ${OLD}, ${OLD}, ${OLD},
      ${options.worktree ? `/tmp/${threadId}` : null}, ${options.archived ? NOW : null})
  `;
});

const createSelectingRun = Effect.fn("createSelectingRetentionRun")(function* (runId: string) {
  const repository = yield* ThreadRetentionRepository;
  yield* repository.createOrGetActiveRun({
    runId,
    trigger: "scheduled",
    policy: "30-days",
    cutoffAt: CUTOFF,
    createdAt: OLD,
  });
  yield* repository.transitionRun({
    runId,
    expectedStatuses: ["queued"],
    nextStatus: "selecting",
    updatedAt: OLD,
  });
});

layer("ThreadRetentionRepository audit gaps", (it) => {
  it.effect("protects actionable plans and excludes both runtime lease kinds", () =>
    Effect.gen(function* () {
      yield* reset();
      for (const id of [
        "plan-ready",
        "session-error",
        "turn-error",
        "archived",
        "activity",
        "worktree",
      ])
        yield* seedThread(id, { archived: id === "archived" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_threads SET interaction_mode = 'plan',
          has_actionable_proposed_plan = 1 WHERE thread_id IN ('plan-ready', 'session-error', 'turn-error', 'archived')
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
        VALUES ('session-error', 'error', ${NOW})
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, started_at, completed_at, checkpoint_files_json
        ) VALUES ('turn-error', 'error-turn', 'error', ${OLD}, ${OLD}, ${OLD}, '[]')
      `;
      yield* sql`UPDATE projection_threads SET latest_turn_id = 'error-turn' WHERE thread_id = 'turn-error'`;
      yield* sql`
        INSERT INTO thread_activity_leases (lease_id, thread_id, activity_kind, acquired_at)
        VALUES ('activity-lease', 'activity', 'computer-use', ${NOW})
      `;
      yield* sql`
        INSERT INTO worktree_runtime_leases (
          lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at
        ) VALUES ('worktree-lease', 'worktree', 'shell', '/tmp/worktree', 1, 1, ${NOW}, ${NOW})
      `;
      const preview = yield* (yield* ThreadRetentionRepository).preview(CUTOFF);
      assert.equal(preview.eligibleCount, 0);
      assert.deepInclude(preview.exclusionCounts, { reason: "waiting_for_user", count: 4 });
      assert.deepInclude(preview.exclusionCounts, { reason: "running", count: 2 });
    }),
  );

  it.effect("counts message and activity attachments plus checkpoint known bytes", () =>
    Effect.gen(function* () {
      yield* reset();
      yield* seedThread("assets", { worktree: true });
      const sql = yield* SqlClient.SqlClient;
      const attachments = JSON.stringify([
        { type: "image", id: "one", name: "one", mimeType: "image/png", sizeBytes: 10 },
        { type: "file", id: "two", name: "two", mimeType: "text/plain", sizeBytes: 20 },
      ]);
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES ('message', 'assets', 'user', 'assets', ${attachments}, 0, ${OLD}, ${OLD})
      `;
      const payload = JSON.stringify({
        title: "computer_use",
        data: { result: { screenshot: { attachmentId: "three", sizeBytes: 30 } } },
      });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES ('activity', 'assets', 'tool', 'tool.completed', 'capture', ${payload}, ${OLD})
      `;
      yield* sql`
        INSERT INTO checkpoint_diff_blobs (
          thread_id, from_turn_count, to_turn_count, diff, created_at
        ) VALUES ('assets', 0, 1, 'é', ${OLD})
      `;
      const preview = yield* (yield* ThreadRetentionRepository).preview(CUTOFF);
      assert.equal(preview.estimatedAttachmentCount, 3);
      assert.equal(preview.estimatedResourceCount, 5);
      assert.equal(preview.estimatedKnownBytes, 62);
      assert.isTrue(preview.attachmentEstimateComplete);
      assert.isTrue(preview.resourceEstimateComplete);
      assert.isTrue(preview.bytesEstimateComplete);
    }),
  );

  it.effect("reports byte-cap completeness independently", () =>
    Effect.gen(function* () {
      yield* reset();
      yield* seedThread("large-byte");
      const sql = yield* SqlClient.SqlClient;
      const attachments = JSON.stringify([
        { type: "file", id: "large", name: "large", mimeType: "x", sizeBytes: 200 * 1024 * 1024 },
      ]);
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES ('large-message', 'large-byte', 'user', '', ${attachments}, 0, ${OLD}, ${OLD})
      `;
      const preview = yield* (yield* ThreadRetentionRepository).preview(CUTOFF);
      assert.equal(preview.estimatedKnownBytes, 100 * 1024 * 1024);
      assert.isTrue(preview.attachmentEstimateComplete);
      assert.isTrue(preview.resourceEstimateComplete);
      assert.isFalse(preview.bytesEstimateComplete);
    }),
  );

  it.effect("caps attachment and checkpoint rows independently", () =>
    Effect.gen(function* () {
      yield* reset();
      yield* seedThread("row-caps");
      const sql = yield* SqlClient.SqlClient;
      const attachments = JSON.stringify(
        Array.from({ length: 1_001 }, (_, index) => ({
          type: "file",
          id: `attachment-${index}`,
          name: `${index}`,
          mimeType: "text/plain",
          sizeBytes: 1,
        })),
      );
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES ('capped-message', 'row-caps', 'user', '', ${attachments}, 0, ${OLD}, ${OLD})
      `;
      yield* sql`
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 1001
        )
        INSERT INTO checkpoint_diff_blobs (
          thread_id, from_turn_count, to_turn_count, diff, created_at
        ) SELECT 'row-caps', value - 1, value, 'x', ${OLD} FROM sequence
      `;
      const preview = yield* (yield* ThreadRetentionRepository).preview(CUTOFF);
      assert.equal(preview.estimatedAttachmentCount, 1_000);
      assert.equal(preview.estimatedResourceCount, 2_000);
      assert.equal(preview.estimatedKnownBytes, 2_000);
      assert.isFalse(preview.attachmentEstimateComplete);
      assert.isFalse(preview.resourceEstimateComplete);
      assert.isFalse(preview.bytesEstimateComplete);
    }),
  );

  it.effect("CAS-inserts one page and returns the outstanding backlog", () =>
    Effect.gen(function* () {
      yield* reset();
      yield* seedThread("page-a");
      yield* seedThread("page-b");
      yield* createSelectingRun("page-run");
      const repository = yield* ThreadRetentionRepository;
      const candidate = {
        threadId: ThreadId.makeUnsafe("page-a"),
        lastActivityAt: OLD,
        deletionCommandId: "delete-page-a",
      };
      const nextCursor = { threadId: candidate.threadId, lastActivityAt: OLD };
      assert.deepEqual(
        yield* repository.insertSelectedPage({
          runId: "page-run",
          candidates: [candidate],
          createdAt: NOW,
          expectedStatus: "selecting",
          expectedCursor: null,
          nextCursor,
        }),
        { applied: true, insertedCount: 1, outstandingBacklogCount: 1 },
      );
      assert.deepEqual(
        yield* repository.insertSelectedPage({
          runId: "page-run",
          candidates: [{ ...candidate, threadId: ThreadId.makeUnsafe("page-b") }],
          createdAt: NOW,
          expectedStatus: "selecting",
          expectedCursor: null,
          nextCursor: { threadId: ThreadId.makeUnsafe("page-b"), lastActivityAt: OLD },
        }),
        { applied: false, insertedCount: 0, outstandingBacklogCount: 1 },
      );
      assert.equal(yield* repository.countOutstandingItems("page-run"), 1);
      assert.isTrue(
        yield* repository.recordRequiredBaselineSequence({
          runId: "page-run",
          sequence: 10,
          updatedAt: NOW,
        }),
      );
      yield* repository.recordRequiredBaselineSequence({
        runId: "page-run",
        sequence: 5,
        updatedAt: NOW,
      });
      assert.equal(
        Option.getOrThrow(yield* repository.getRun("page-run")).requiredBaselineSequence,
        10,
      );
    }),
  );

  it.effect("persists exponential retry state and opens the one-hour failure circuit", () =>
    Effect.gen(function* () {
      yield* reset();
      yield* createSelectingRun("retry-run");
      const repository = yield* ThreadRetentionRepository;
      const failures = [
        "2026-03-01T00:00:00.000Z",
        "2026-03-01T00:10:00.000Z",
        "2026-03-01T00:20:00.000Z",
      ];
      for (const failedAt of failures)
        yield* repository.recordRunFailure({
          runId: "retry-run",
          expectedStatuses: ["selecting"],
          failedAt,
          lastErrorCode: "transient",
        });
      const state = Option.getOrThrow(
        yield* repository.readRunRetryState("retry-run", "2026-03-01T00:21:00.000Z"),
      );
      assert.equal(state.retryOrdinal, 3);
      assert.equal(state.failureCountInWindow, 3);
      assert.equal(state.nextAttemptAt, "2026-03-02T00:20:00.000Z");
      assert.equal(state.circuitOpenUntil, state.nextAttemptAt);
      assert.isTrue(state.circuitOpen);
      assert.deepEqual(
        yield* repository.getRecentFailureSummary({
          since: "2026-02-28T23:20:00.000Z",
          limit: 3,
        }),
        {
          failureCount: 3,
          latestFailureAt: "2026-03-01T00:20:00.000Z",
          consecutiveFailureCount: 3,
        },
      );
      assert.isFalse(
        Option.getOrThrow(
          yield* repository.readRunRetryState("retry-run", "2026-03-02T00:20:00.000Z"),
        ).circuitOpen,
      );
      yield* repository.clearRunRetryState({
        runId: "retry-run",
        expectedStatuses: ["selecting"],
        updatedAt: "2026-03-03T00:00:00.000Z",
      });
      for (let day = 1; day <= 8; day++)
        yield* repository.recordRunFailure({
          runId: "retry-run",
          expectedStatuses: ["selecting"],
          failedAt: `2026-04-${String(day).padStart(2, "0")}T00:00:00.000Z`,
          lastErrorCode: "transient",
        });
      const capped = Option.getOrThrow(
        yield* repository.readRunRetryState("retry-run", "2026-04-08T00:01:00.000Z"),
      );
      assert.equal(capped.retryOrdinal, 8);
      assert.equal(capped.failureCountInWindow, 1);
      assert.equal(capped.nextAttemptAt, "2026-04-09T00:00:00.000Z");
      assert.isNull(capped.circuitOpenUntil);
    }),
  );
});
