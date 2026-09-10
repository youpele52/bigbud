import { ThreadId } from "@bigbud/contracts";
import { assert } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { projectionSnapshotLayer } from "./ProjectionSnapshotQuery.test.helpers.ts";

const fixture = crypto.randomUUID();
const project = `mobile-project-${fixture}`;
const activeThreadA = `mobile-thread-a-${fixture}`;
const activeThreadB = `mobile-thread-b-${fixture}`;
const archivedThread = `mobile-thread-archived-${fixture}`;
const deletedThread = `mobile-thread-deleted-${fixture}`;
const threadId = (value: string) => ThreadId.makeUnsafe(value);

projectionSnapshotLayer("ProjectionSnapshotQuery.mobile", (it) => {
  it.effect("limits summaries in SQL and hydrates only the selected history", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${project}, 'Mobile', '/tmp/mobile',
          '{"provider":"codex","model":"gpt-5.4"}', '[]',
          '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z', NULL
        )
      `;

      for (const [id, archivedAt, deletedAt] of [
        [activeThreadA, null, null],
        [activeThreadB, null, null],
        [archivedThread, "2026-09-09T00:00:01.000Z", null],
        [deletedThread, null, "2026-09-09T00:00:02.000Z"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json,
            branch, worktree_path, latest_turn_id, created_at, updated_at,
            archived_at, deleted_at
          ) VALUES (
            ${id}, ${project}, ${id},
            '{"provider":"codex","model":"gpt-5.4"}',
            NULL, NULL, NULL, '2026-09-09T00:00:03.000Z',
            '2026-09-09T00:00:03.000Z', ${archivedAt}, ${deletedAt}
          )
        `;
      }

      for (let index = 1; index <= 6; index += 1) {
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming,
            created_at, updated_at
          ) VALUES (
            ${`message-a-${fixture}-${index}`}, ${activeThreadA}, NULL, 'user',
            ${`A-${index}`}, 0,
            ${`2026-09-09T00:01:0${index}.000Z`},
            ${`2026-09-09T00:01:0${index}.000Z`}
          )
        `;
      }
      for (let index = 1; index <= 20; index += 1) {
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming,
            created_at, updated_at
          ) VALUES (
            ${`message-b-${fixture}-${index}`}, ${activeThreadB}, NULL, 'assistant',
            ${`B-${index}`}, 0,
            ${`2026-09-09T00:02:${String(index).padStart(2, "0")}.000Z`},
            ${`2026-09-09T00:02:${String(index).padStart(2, "0")}.000Z`}
          )
        `;
      }
      for (const [index, kind] of [
        [1, "approval.requested"],
        [2, "approval.resolved"],
        [3, "user-input.requested"],
        [4, "user-input.resolved"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
          ) VALUES (
            ${`activity-b-${fixture}-${index}`}, ${activeThreadB}, NULL, 'info', ${kind},
            ${kind}, '{}', ${`2026-09-09T00:03:0${index}.000Z`}
          )
        `;
      }
      const latestTurnB = `mobile-turn-b-${fixture}`;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_files_json
        ) VALUES (
          ${activeThreadB}, ${latestTurnB}, 'completed',
          '2026-09-09T00:03:05.000Z', '[]'
        )
      `;
      yield* sql`
        UPDATE projection_threads SET latest_turn_id = ${latestTurnB}
        WHERE thread_id = ${activeThreadB}
      `;
      for (const [index, kind] of [
        [5, "approval.both"],
        [6, "Approval.case"],
        [7, "User-input.case"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
          ) VALUES (
            ${`activity-b-${fixture}-${index}`}, ${activeThreadB},
            ${index === 5 ? latestTurnB : null}, 'info', ${kind},
            ${kind}, '{}', ${`2026-09-09T00:03:0${index}.000Z`}
          )
        `;
      }
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 42, '2026-09-09T00:05:00.000Z')
        `;
      }

      const baseline = yield* snapshotQuery.getMobileRecoveryBaseline!(threadId(activeThreadA));
      const summaryA = baseline.snapshot.threads.find(
        (thread) => thread.id === threadId(activeThreadA),
      );
      const summaryB = baseline.snapshot.threads.find(
        (thread) => thread.id === threadId(activeThreadB),
      );
      const selectedA =
        baseline.selectedThread?.status === "present" ? baseline.selectedThread.thread : null;

      assert.equal(baseline.snapshotSequence, 42);
      assert.equal(
        baseline.snapshot.threads.some((thread) => thread.id === threadId(archivedThread)),
        false,
      );
      assert.equal(
        baseline.snapshot.threads.some((thread) => thread.id === threadId(deletedThread)),
        false,
      );
      assert.deepEqual(
        summaryA?.messages.map((message) => message.text),
        ["A-3", "A-4", "A-5", "A-6"],
      );
      assert.deepEqual(
        summaryB?.messages.map((message) => message.text),
        ["B-17", "B-18", "B-19", "B-20"],
      );
      assert.deepEqual(
        summaryB?.activities.map((activity) => activity.kind),
        [
          "approval.requested",
          "approval.resolved",
          "user-input.requested",
          "user-input.resolved",
          "approval.both",
        ],
      );
      assert.equal(selectedA?.messages.length, 6);
    }),
  );

  it.effect("reports missing and deleted selected threads without hydrating their history", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${`${project}-deleted`}, 'Mobile', '/tmp/mobile',
          '{"provider":"codex","model":"gpt-5.4"}', '[]',
          '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json,
          branch, worktree_path, latest_turn_id, created_at, updated_at,
          archived_at, deleted_at
        ) VALUES (
          ${`${deletedThread}-second`}, ${`${project}-deleted`}, 'Deleted',
          '{"provider":"codex","model":"gpt-5.4"}',
          NULL, NULL, NULL, '2026-09-09T00:00:03.000Z',
          '2026-09-09T00:00:03.000Z', NULL,
          '2026-09-09T00:00:02.000Z'
        )
      `;
      yield* sql`DELETE FROM projection_state`;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 7, '2026-09-09T00:06:00.000Z')
        `;
      }
      const deleted = yield* snapshotQuery.getMobileRecoveryBaseline!(
        threadId(`${deletedThread}-second`),
      );
      const missing = yield* snapshotQuery.getMobileRecoveryBaseline!(
        threadId(`${fixture}-missing`),
      );

      assert.deepEqual(deleted.selectedThread, { status: "deleted" });
      assert.deepEqual(missing.selectedThread, { status: "missing" });
      assert.equal(
        deleted.snapshot.threads.some(
          (thread) => thread.id === threadId(`${deletedThread}-second`),
        ),
        false,
      );
    }),
  );

  it.effect("fails closed when mobile projection cursors are not published together", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_state`;
      const projectors = Object.values(ORCHESTRATION_PROJECTOR_NAMES);
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES (${projectors[0]!}, 1, '2026-09-09T00:07:00.000Z')
      `;
      const result = yield* snapshotQuery.getMobileRecoveryBaseline!(null).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("fails closed during a concurrent staged projector publication", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_state`;
      const projectors = Object.values(ORCHESTRATION_PROJECTOR_NAMES);
      for (const projector of projectors) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 7, '2026-09-09T00:08:00.000Z')
        `;
      }
      const partialPublished = yield* Deferred.make<void>();
      const allowCompletion = yield* Deferred.make<void>();
      const writer = yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* sql.withTransaction(
            sql`
              UPDATE projection_state
              SET last_applied_sequence = 8, updated_at = '2026-09-09T00:08:01.000Z'
              WHERE projector = ${projectors[0]!}
            `,
          );
          yield* Deferred.succeed(partialPublished, undefined);
          yield* Deferred.await(allowCompletion);
          yield* sql.withTransaction(
            sql`
              UPDATE projection_state
              SET last_applied_sequence = 8, updated_at = '2026-09-09T00:08:01.000Z'
              WHERE projector <> ${projectors[0]!}
            `,
          );
        }),
      );

      yield* Deferred.await(partialPublished);
      const result = yield* snapshotQuery.getMobileRecoveryBaseline!(null).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      yield* Deferred.succeed(allowCompletion, undefined);
      yield* Fiber.join(writer);
    }),
  );
});
