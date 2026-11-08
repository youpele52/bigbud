import { MessageId, ProjectId, ThreadId, type OrchestrationReadModel } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ORCHESTRATION_PROJECTOR_NAMES } from "../orchestration/Layers/ProjectionPipeline.ts";
import { projectionSnapshotLayer } from "../orchestration/Layers/ProjectionSnapshotQuery.test.helpers.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadDetailNotFoundError } from "../orchestration/Services/ProjectionCatalogQuery.ts";
import { readBoundedMobileSnapshot, readBoundedMobileThread } from "./ws.mobile.bounded.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

const threadId = ThreadId.makeUnsafe("mobile-thread");
const AT = "2026-01-01T00:00:00.000Z";

function shell(): OrchestrationReadModel {
  return {
    snapshotSequence: 5,
    updatedAt: AT,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.makeUnsafe("mobile-project"),
        title: "Mobile",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: AT,
        updatedAt: AT,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
  } as unknown as OrchestrationReadModel;
}

function context(input: { readonly detailMissing?: boolean } = {}) {
  const calls = { getSnapshot: 0, detail: 0 };
  const value = {
    projectionSnapshotQuery: {
      getSnapshot: () => {
        calls.getSnapshot += 1;
        return Effect.die(new Error("the full snapshot must not be built for mobile"));
      },
      getMobileRecoveryBaseline: () =>
        Effect.succeed({ snapshot: shell(), snapshotSequence: 5, selectedThread: null }),
    },
    projectionOperationalStateQuery: Option.some({
      getThreadOperationalState: () => Effect.succeed(Option.some(shell())),
    }),
    projectionCatalogQuery: {
      getSelectedThreadDetail: () => {
        calls.detail += 1;
        if (input.detailMissing) {
          return Effect.fail(new ProjectionThreadDetailNotFoundError({ threadId }));
        }
        return Effect.succeed({
          projectionSequence: 5,
          threadId,
          projectId: ProjectId.makeUnsafe("mobile-project"),
          activityTurnId: null,
          messages: ["newest", "older"].map((text, index) => ({
            id: MessageId.makeUnsafe(`message-${text}`),
            role: "user" as const,
            text,
            attachments: [],
            attachmentsTruncated: false,
            turnId: null,
            streaming: false,
            createdAt: `2026-01-0${2 - index}T00:00:00.000Z`,
            updatedAt: `2026-01-0${2 - index}T00:00:00.000Z`,
          })),
          messageWindow: {
            order: "newest-first" as const,
            requestedCursor: null,
            newestCursor: null,
            oldestCursor: null,
            nextCursor: null,
            hasOlder: false,
          },
          activities: [],
          activitiesTruncated: false,
          pendingApprovals: [],
          pendingApprovalsTruncated: false,
          pendingUserInputs: [],
          pendingUserInputsTruncated: false,
          activePlan: null,
          activeTasks: [],
          activeTasksTruncated: false,
          checkpoints: [],
          checkpointsTruncated: false,
        });
      },
    },
  } as unknown as WsRpcContext;
  return { value, calls };
}

it.effect("builds getMobileThread from the bounded detail, never the full snapshot", () =>
  Effect.gen(function* () {
    const { value, calls } = context();
    const thread = yield* readBoundedMobileThread(value, threadId);

    assert.equal(calls.getSnapshot, 0);
    assert.equal(calls.detail, 1);
    assert.deepEqual(
      thread.messages.map((message) => message.text),
      ["older", "newest"],
    );
  }),
);

it.effect("reports a missing mobile thread as not found", () =>
  Effect.gen(function* () {
    const { value, calls } = context({ detailMissing: true });
    const exit = yield* Effect.exit(readBoundedMobileThread(value, threadId));

    assert.isTrue(Exit.isFailure(exit));
    assert.include(JSON.stringify(exit), "Thread not found.");
    assert.equal(calls.getSnapshot, 0);
  }),
);

it.effect("serves the legacy mobile getSnapshot from the bounded baseline", () =>
  Effect.gen(function* () {
    const { value, calls } = context();
    const snapshot = yield* readBoundedMobileSnapshot(value);

    assert.equal(snapshot.threads.length, 1);
    assert.equal(calls.getSnapshot, 0);
  }),
);

projectionSnapshotLayer("mobile baseline history window", (it) => {
  it.effect("caps approval history like the desktop detail but keeps pending requests", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES (
          'history-thread', 'history-project', 'History',
          '{"provider":"codex","model":"gpt-5-codex"}', ${AT}, ${AT}
        )
      `;
      yield* sql`
        WITH RECURSIVE sequence(value) AS (
          SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 59
        )
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        SELECT printf('approval-%02d', value), 'history-thread', NULL, 'approval',
          CASE WHEN value % 2 = 0 THEN 'approval.requested' ELSE 'approval.resolved' END,
          'Approval', printf('{"requestId":"request-%02d"}', value / 2), value,
          printf('2026-01-01T00:%02d:00.000Z', value)
        FROM sequence
      `;
      // The oldest request is still pending: it must survive the history window.
      yield* sql`
        INSERT INTO projection_pending_approvals (request_id, thread_id, status, created_at)
        VALUES ('request-00', 'history-thread', 'pending', ${AT})
      `;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 60, ${AT})
        `;
      }

      const baseline = yield* snapshotQuery.getMobileRecoveryBaseline!(null);
      const thread = baseline.snapshot.threads.find((entry) => entry.id === "history-thread");
      const ids: string[] = thread?.activities.map((activity) => activity.id) ?? [];

      assert.isAtMost(ids.length, 21);
      assert.include(ids, "approval-59");
      assert.include(ids, "approval-00");
      assert.notInclude(ids, "approval-01");
    }),
  );
});
