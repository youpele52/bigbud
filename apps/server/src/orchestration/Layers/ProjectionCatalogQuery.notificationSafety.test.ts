import { ProjectId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const now = "2026-11-11T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("safety-thread");
const projectId = ProjectId.makeUnsafe("safety-project");

it.layer(ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "bounded notification safety summaries",
  (it) => {
    it.effect(
      "round-trips native proof, ownership, pending controls, and capped queues without transcript hydration",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const query = yield* ProjectionCatalogQuery;
          yield* insertProjectionThreadParent({ sql, threadId, projectId, createdAt: now });
          yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, started_at,
        completed_at, terminal_outcome, source_proposed_plan_thread_id, source_proposed_plan_id, checkpoint_files_json)
        VALUES (${threadId}, 'turn-current', 'completed', ${now}, ${now}, ${now}, 'completed', ${threadId}, 'source-plan', '[]')`;
          const queued = Array.from({ length: 105 }, (_, i) => ({ id: `queued-${i}` }));
          yield* sql`UPDATE projection_threads SET latest_turn_id = 'turn-current',
        queued_prompts_json = ${JSON.stringify(queued)},
        pending_turn_start_json = ${JSON.stringify({ messageId: "starting", requestedAt: now, requestedSequence: 1 })},
        pending_interrupt_flush_intent_json = ${JSON.stringify({ intentId: "flush", queuedPromptIds: ["queued-0"], requestedTurnId: null, requestedAt: now })}
        WHERE thread_id = ${threadId}`;
          const task = {
            id: "owned",
            kind: "providerSubagent",
            turnId: "turn-current",
            status: "inProgress",
            subject: "Owned task",
            background: true,
            freshness: { sessionEpoch: "epoch", sourcePriority: 1, observedOrdinal: 1 },
            createdAt: now,
            updatedAt: now,
          };
          yield* sql`INSERT INTO projection_thread_tasks (thread_id, task_id, task_json, created_at, updated_at)
        VALUES (${threadId}, 'owned', ${JSON.stringify(task)}, ${now}, ${now})`;
          yield* sql`INSERT INTO projection_pending_approvals (request_id, thread_id, turn_id, status, created_at)
        VALUES ('approval', ${threadId}, 'turn-current', 'pending', ${now})`;
          yield* sql`INSERT INTO thread_delegations (delegation_id, caller_thread_id, source_message_id, invocation_id,
        root_delegation_id, depth, target_kind, child_thread_id, child_turn_id, state, created_at, updated_at)
        VALUES ('delegation', ${threadId}, 'source', 'invoke', 'delegation', 0, 'project', 'child', 'child-turn', 'completed', ${now}, ${now})`;
          yield* insertProjectionThreadParent({
            sql,
            threadId: ThreadId.makeUnsafe("child"),
            projectId,
            createdAt: now,
          });
          yield* sql`INSERT INTO projection_thread_activities
            (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
            VALUES ('accepted', 'child', 'native-child-turn', 'info', 'text-generation.user-turn-bound', 'Bound',
              ${JSON.stringify({ messageId: "source", sessionEpoch: 7 })}, 10, ${now}),
              ('later', 'child', 'unrelated-later-turn', 'info', 'text-generation.user-turn-bound', 'Bound',
              ${JSON.stringify({ messageId: "source", sessionEpoch: 8 })}, 11, ${now}),
              ('other-request', 'child', 'wrong-request-turn', 'info', 'text-generation.user-turn-bound', 'Bound',
              ${JSON.stringify({ messageId: "other", sessionEpoch: 6 })}, 9, ${now})`;
          yield* sql`INSERT INTO projection_thread_proposed_plans
            (plan_id, thread_id, turn_id, plan_markdown, implemented_at, created_at, updated_at)
            VALUES ('current-plan', ${threadId}, 'turn-current', 'Current plan', NULL, ${now}, ${now}),
              ('historical-plan', ${threadId}, 'older-turn', 'Implemented history', ${now}, ${now}, '2099-01-01T00:00:00.000Z')`;
          const page = yield* query.getProjectThreadSummaries({ projectId });
          const summary = page.threads.find((entry) => entry.id === threadId)!;
          assert.equal(summary.latestTurn?.terminalOutcome, "completed");
          assert.deepEqual(summary.latestTurn?.sourceProposedPlan, {
            threadId,
            planId: "source-plan",
          });
          const safety = summary.notificationSafety!;
          assert.equal(safety.turnId, "turn-current");
          assert.equal(safety.hasActionablePlan, true);
          assert.deepEqual(safety.selectedPlan, {
            id: "current-plan",
            turnId: TurnId.makeUnsafe("turn-current"),
            updatedAt: now,
            implementedAt: null,
          });
          yield* sql`UPDATE projection_thread_proposed_plans SET implemented_at = ${now}, updated_at = '2099-02-01T00:00:00.000Z' WHERE plan_id = 'current-plan'`;
          const updated = (yield* query.getProjectThreadSummaries({ projectId })).threads.find(
            (entry) => entry.id === threadId,
          )!;
          assert.equal(updated.notificationSafety?.hasActionablePlan, false);
          assert.equal(updated.notificationSafety?.selectedPlan?.implementedAt, now);
          assert.equal(safety.tasks[0]?.background, true);
          assert.deepEqual(safety.tasks[0]?.freshness, task.freshness);
          assert.deepEqual(safety.childThreadIds, [ThreadId.makeUnsafe("child")]);
          assert.deepEqual(safety.childTurns, [
            {
              threadId: ThreadId.makeUnsafe("child"),
              turnId: "native-child-turn" as never,
              requestMessageId: "source" as never,
              sessionEpoch: 7,
            },
          ]);
          assert.deepEqual(safety.pendingRequestIds, ["approval"]);
          assert.equal(safety.queuedPromptIds.length, 100);
          assert.equal(safety.overflow, true);
          assert.equal(safety.pendingStartMessageId, "starting");
          assert.equal(safety.pendingFlush?.intentId, "flush");
        }),
    );
  },
);
