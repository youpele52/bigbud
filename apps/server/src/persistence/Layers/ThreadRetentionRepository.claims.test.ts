import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadRetentionRepository } from "../Services/ThreadRetentionRepository.ts";
import {
  cutoffAt,
  layer,
  now,
  oldAt,
  projectId,
  resetData,
  seedProject,
  seedThread,
} from "./ThreadRetentionRepository.test.helpers.ts";

layer("ThreadRetentionRepository claims", (it) => {
  it.effect("claims atomically and rejects post-claim endpoint writes", () =>
    Effect.gen(function* () {
      yield* resetData();
      yield* seedProject();
      yield* seedThread("claimed");
      yield* seedThread("peer");
      const repository = yield* ThreadRetentionRepository;
      yield* repository.createOrGetActiveRun({
        runId: "run-claim",
        trigger: "manual",
        policy: "30-days",
        cutoffAt,
        createdAt: now,
      });
      yield* repository.transitionRun({
        runId: "run-claim",
        expectedStatuses: ["queued"],
        nextStatus: "selecting",
        updatedAt: now,
      });
      yield* repository.insertSelectedPage({
        runId: "run-claim",
        candidates: [
          {
            threadId: ThreadId.makeUnsafe("claimed"),
            lastActivityAt: oldAt,
            deletionCommandId: "delete-claimed",
          },
        ],
        createdAt: now,
        expectedStatus: "selecting",
        expectedCursor: null,
        nextCursor: { threadId: ThreadId.makeUnsafe("claimed"), lastActivityAt: oldAt },
      });
      assert.deepEqual(
        yield* repository.recheckAndClaimItem({
          runId: "run-claim",
          threadId: ThreadId.makeUnsafe("claimed"),
          expectedLastActivityAt: oldAt,
          cutoffAt,
          claimedAt: now,
        }),
        { claimed: true },
      );
      const sql = yield* SqlClient.SqlClient;
      const rejected = yield* Effect.exit(sql`
        INSERT INTO projection_thread_watches (
          watch_id, watcher_thread_id, watched_thread_id, watched_thread_title,
          source_message_id, status, created_at, triggered_at
        ) VALUES ('watch-1', 'peer', 'claimed', 'Claimed', 'message-1', 'active', ${now}, NULL)
      `);
      assert.equal(rejected._tag, "Failure");
      const delegationRejected = yield* Effect.exit(sql`
        INSERT INTO thread_delegations (
          delegation_id, caller_thread_id, source_message_id, invocation_id,
          root_delegation_id, depth, target_kind, child_thread_id, child_turn_id,
          state, created_at, updated_at
        ) VALUES ('delegation-1', 'claimed', 'message-1', 'invocation-1',
          'delegation-1', 0, 'project', 'peer', 'turn-1', 'reserved', ${now}, ${now})
      `);
      assert.equal(delegationRejected._tag, "Failure");
      const scheduleRejected = yield* Effect.exit(sql`
        INSERT INTO automation_schedules (
          automation_id, project_id, target_thread_id, title, prompt, cron_expression,
          timezone, next_run_at, created_at, updated_at
        ) VALUES ('automation-1', ${projectId}, 'claimed', 'Automation', 'Prompt',
          '* * * * *', 'UTC', ${now}, ${now}, ${now})
      `);
      assert.equal(scheduleRejected._tag, "Failure");
    }),
  );

  it.effect("skips a selected item when activity changes before claim", () =>
    Effect.gen(function* () {
      yield* resetData();
      yield* seedProject();
      yield* seedThread("changed");
      const repository = yield* ThreadRetentionRepository;
      yield* repository.createOrGetActiveRun({
        runId: "run-changed",
        trigger: "manual",
        policy: "30-days",
        cutoffAt,
        createdAt: now,
      });
      yield* repository.transitionRun({
        runId: "run-changed",
        expectedStatuses: ["queued"],
        nextStatus: "selecting",
        updatedAt: now,
      });
      yield* repository.insertSelectedPage({
        runId: "run-changed",
        candidates: [
          {
            threadId: ThreadId.makeUnsafe("changed"),
            lastActivityAt: oldAt,
            deletionCommandId: "delete-changed",
          },
        ],
        createdAt: now,
        expectedStatus: "selecting",
        expectedCursor: null,
        nextCursor: { threadId: ThreadId.makeUnsafe("changed"), lastActivityAt: oldAt },
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('changed-user', 'changed', 'user', 'later', 0, ${now}, ${now})
      `;
      assert.deepEqual(
        yield* repository.recheckAndClaimItem({
          runId: "run-changed",
          threadId: ThreadId.makeUnsafe("changed"),
          expectedLastActivityAt: oldAt,
          cutoffAt,
          claimedAt: now,
        }),
        { claimed: false, reason: "activity_changed" },
      );
      const item = yield* repository.findItemByDeletionCommandId("delete-changed");
      assert.equal(Option.getOrThrow(item).status, "skipped");
    }),
  );
});
