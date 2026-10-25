import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@bigbud/contracts";
import { ProviderTurnAdmissions } from "../Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "./ProviderTurnAdmissions.ts";
import { ThreadRetentionRepository } from "../Services/ThreadRetentionRepository.ts";
import { ThreadRetentionRepositoryLive } from "./ThreadRetentionRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";
import { admissionFixture } from "./ProviderTurnAdmissions.test.ts";
import { makeEntityPurgeSql } from "../../deletion/Layers/EntityPurge.sql.ts";

const old = "2026-01-01T00:00:00.000Z",
  now = "2026-09-30T00:00:00.000Z";
const layer = Layer.mergeAll(ProviderTurnAdmissionsLive, ThreadRetentionRepositoryLive).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const seed = Effect.fn("seedAdmissionDeletion")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO projection_projects (project_id, title, scripts_json, created_at, updated_at) VALUES ('fixture-project', 'Fixture', '[]', ${old}, ${old})`;
  const threadId = ThreadId.makeUnsafe(id);
  yield* insertProjectionThreadParent({ sql, threadId, createdAt: old });
  return {
    ...admissionFixture(id),
    ownerThreadId: threadId,
    binding: { ...admissionFixture(id).binding, threadId },
  };
});
const select = Effect.fn("selectAdmissionRetention")(function* (threadId: ThreadId) {
  const retention = yield* ThreadRetentionRepository;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM thread_retention_run_items`;
  yield* sql`DELETE FROM thread_retention_runs`;
  yield* retention.createOrGetActiveRun({
    runId: "run",
    trigger: "manual",
    policy: "30-days",
    cutoffAt: now,
    createdAt: now,
  });
  yield* retention.transitionRun({
    runId: "run",
    expectedStatuses: ["queued"],
    nextStatus: "selecting",
    updatedAt: now,
  });
  yield* retention.insertSelectedPage({
    runId: "run",
    candidates: [{ threadId, lastActivityAt: old, deletionCommandId: "delete" }],
    createdAt: now,
    expectedStatus: "selecting",
    expectedCursor: null,
    nextCursor: { threadId, lastActivityAt: old },
  });
  return { runId: "run", threadId, expectedLastActivityAt: old, cutoffAt: now, claimedAt: now };
});
it.layer(layer)("reverse durable admission deletion fences", (it) => {
  for (const state of ["dispatch-intent", "accepted"] as const)
    it.effect(
      `${state} after transient runtime loss excludes retention and destructive quiescence`,
      () =>
        Effect.gen(function* () {
          const journal = yield* ProviderTurnAdmissions;
          const retention = yield* ThreadRetentionRepository;
          const sql = yield* SqlClient.SqlClient;
          const input = yield* seed(state);
          const claim = yield* select(input.ownerThreadId);
          let row = yield* journal.reserve(input);
          row = yield* journal.transition(row, "dispatch-intent", now);
          if (state === "accepted") row = yield* journal.transition(row, "accepted", now);
          yield* sql`DELETE FROM provider_session_runtime`;
          yield* sql`DELETE FROM projection_thread_sessions`;
          yield* sql`DELETE FROM worktree_runtime_leases`;
          yield* sql`DELETE FROM thread_activity_leases`;
          assert.equal((yield* retention.preview(now)).eligibleCount, 0);
          assert.deepEqual(yield* retention.selectNextPage({ cutoffAt: now, limit: 10 }), []);
          assert.deepEqual(yield* retention.recheckAndClaimItem(claim), {
            claimed: false,
            reason: "pending_work",
          });
          const queries = makeEntityPurgeSql(sql);
          assert.equal(
            (yield* queries.countThreadRuntimes({ threadId: input.ownerThreadId })).count,
            1,
          );
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(queries.deleteThreadDependents({ threadId: input.ownerThreadId })),
            ),
          );
          if (state === "accepted") {
            yield* journal.transition(row, "terminal", now, "retained", "completed");
            assert.equal(
              (yield* queries.countThreadRuntimes({ threadId: input.ownerThreadId })).count,
              0,
            );
            assert.equal((yield* retention.preview(now)).eligibleCount, 1);
          }
        }),
    );
  for (const first of ["dispatch", "claim"] as const)
    it.effect(`${first} wins retention claim versus dispatch-intent transaction race`, () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const retention = yield* ThreadRetentionRepository;
        const sql = yield* SqlClient.SqlClient;
        const input = yield* seed(first);
        const claim = yield* select(input.ownerThreadId);
        const row = yield* journal.reserve(input);
        const dispatch = journal.transition(row, "dispatch-intent", now);
        const deletion = retention.recheckAndClaimItem(claim);
        if (first === "dispatch") {
          yield* sql.withTransaction(dispatch);
          assert.deepEqual(yield* deletion, { claimed: false, reason: "pending_work" });
        } else {
          assert.deepEqual(yield* sql.withTransaction(deletion), { claimed: true });
          assert.isTrue(Exit.isFailure(yield* Effect.exit(dispatch)));
        }
      }),
    );
  it.effect(
    "learning owner and synthetic binding both protect deletion, but terminal retained records do not",
    () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const sql = yield* SqlClient.SqlClient;
        const input = yield* seed("learning-owner");
        const bound = yield* seed("learning-bound");
        let row = yield* journal.reserve({
          ...input,
          namespace: "learning",
          binding: bound.binding,
        });
        row = yield* journal.transition(row, "dispatch-intent", now);
        for (const threadId of [input.ownerThreadId, bound.ownerThreadId])
          assert.equal((yield* makeEntityPurgeSql(sql).countThreadRuntimes({ threadId })).count, 1);
        row = yield* journal.transition(row, "accepted", now);
        yield* journal.transition(row, "terminal", now, "retained", "completed");
        for (const threadId of [input.ownerThreadId, bound.ownerThreadId])
          assert.equal((yield* makeEntityPurgeSql(sql).countThreadRuntimes({ threadId })).count, 0);
      }),
  );
  for (const first of ["dispatch", "claim"] as const)
    it.effect(`${first} also fences a legacy-subtree root versus descendant dispatch`, () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const retention = yield* ThreadRetentionRepository;
        const sql = yield* SqlClient.SqlClient;
        const root = yield* seed(`subtree-root-${first}`);
        const child = yield* seed(`subtree-child-${first}`);
        yield* sql`UPDATE projection_threads SET parent_thread_id = ${root.ownerThreadId} WHERE thread_id = ${child.ownerThreadId}`;
        const claim = yield* select(root.ownerThreadId);
        const row = yield* journal.reserve(child);
        if (first === "dispatch") {
          yield* journal.transition(row, "dispatch-intent", now);
          assert.deepEqual(yield* retention.recheckAndClaimItem(claim), {
            claimed: false,
            reason: "pending_work",
          });
        } else {
          assert.deepEqual(yield* retention.recheckAndClaimItem(claim), { claimed: true });
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(journal.transition(row, "dispatch-intent", now))),
          );
        }
      }),
    );
});
