import { EventId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  THREAD_DETAIL_TEXT_PREVIEW_LENGTH,
  THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import type {
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { assert } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { withMobileTooLargeNotice } from "../../mobile/mobileRecordBounds.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  at,
  insertActivities,
  insertCheckpointTurn,
  insertMessages,
  insertPendingApproval,
  insertPendingUserInput,
  insertProject,
  insertProposedPlan,
  insertThread,
  publishProjectionState,
} from "./ProjectionSnapshotQuery.mobile.bounds.fixtures.ts";
import { projectionSnapshotLayer } from "./ProjectionSnapshotQuery.test.helpers.ts";

const fixture = crypto.randomUUID();
const project = `mobile-records-project-${fixture}`;
const KB = 1024;

const bigText = "m".repeat(300 * KB);
const bigPlan = `# Big plan\n${"p".repeat(300 * KB)}`;
const bigPayload = JSON.stringify({ output: "o".repeat(300 * KB) });
const checkpointFiles = Array.from({ length: 5_000 }, (_, index) => ({
  path: `src/generated/file-${String(index).padStart(5, "0")}.ts`,
  kind: "modified",
  additions: index,
  deletions: 1,
}));
const checkpointFilesJson = JSON.stringify(checkpointFiles);

const getBaseline = Effect.fn("getBaseline")(function* (threadId: string) {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const baseline = yield* snapshotQuery.getMobileRecoveryBaseline!(ThreadId.makeUnsafe(threadId));
  const selected = baseline.selectedThread;
  assert.equal(selected?.status, "present");
  const summary = baseline.snapshot.threads.find((thread) => thread.id === threadId);
  assert.isDefined(summary);
  return {
    selected: (selected?.status === "present" ? selected.thread : null) as OrchestrationThread,
    summary: summary as OrchestrationThread,
  };
});

projectionSnapshotLayer("ProjectionSnapshotQuery.mobile.records", (it) => {
  it.effect("bounds one oversized message, plan, payload and file list with notices", () =>
    Effect.gen(function* () {
      const thread = `mobile-records-bounded-${fixture}`;
      const turn = "records-turn-1";
      yield* insertProject(project);
      yield* insertThread(project, thread, turn);
      yield* insertMessages(thread, ["small", bigText]);
      yield* insertProposedPlan(thread, `${thread}-plan`, turn, 1, bigPlan);
      yield* insertActivities(thread, [
        {
          id: `${thread}-tool`,
          kind: "tool.completed",
          sequence: 1,
          turnId: turn,
          payload: bigPayload,
        },
      ]);
      yield* insertCheckpointTurn(thread, turn, 1, checkpointFilesJson);
      yield* publishProjectionState(21);

      const { selected, summary } = yield* getBaseline(thread);
      const boundedText = withMobileTooLargeNotice(
        bigText.slice(0, THREAD_DETAIL_TEXT_PREVIEW_LENGTH),
        bigText.length,
      );

      for (const view of [selected, summary]) {
        assert.deepEqual(
          view.messages.map((message) => message.text),
          ["small", boundedText],
        );
        assert.include(view.messages[1]?.text, "(300 KB)");
        assert.equal(
          view.proposedPlans[0]?.planMarkdown,
          withMobileTooLargeNotice(
            bigPlan.slice(0, THREAD_DETAIL_TEXT_PREVIEW_LENGTH),
            bigPlan.length,
          ),
        );
        const tool = view.activities.find((activity) => activity.id === `${thread}-tool`);
        assert.deepEqual(tool?.payload, {});
        assert.equal(tool?.payloadTruncated, true);
        assert.equal(tool?.payloadLength, bigPayload.length);
      }

      const files = selected.checkpoints[0]?.files ?? [];
      assert.isAbove(files.length, 0);
      assert.isBelow(files.length, checkpointFiles.length);
      assert.deepEqual(files, checkpointFiles.slice(0, files.length));
      assert.isAtMost(JSON.stringify(files).length, THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD);
      // The next file would cross the threshold: the kept prefix is as long as it can be.
      assert.isAbove(
        JSON.stringify(checkpointFiles.slice(0, files.length + 1)).length,
        THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD,
      );
    }),
  );

  it.effect("leaves the canonical rows whole", () =>
    Effect.gen(function* () {
      const thread = `mobile-records-bounded-${fixture}`;
      const sql = yield* SqlClient.SqlClient;
      const [message] = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = ${`${thread}-message-2`}
      `;
      const [plan] = yield* sql<{ readonly planMarkdown: string }>`
        SELECT plan_markdown AS "planMarkdown" FROM projection_thread_proposed_plans
        WHERE plan_id = ${`${thread}-plan`}
      `;
      const [activity] = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM projection_thread_activities
        WHERE activity_id = ${`${thread}-tool`}
      `;
      const [turn] = yield* sql<{ readonly files: string }>`
        SELECT checkpoint_files_json AS files FROM projection_turns
        WHERE thread_id = ${thread} AND turn_id = 'records-turn-1'
      `;

      assert.equal(message?.text, bigText);
      assert.equal(plan?.planMarkdown, bigPlan);
      assert.equal(activity?.payload, bigPayload);
      assert.equal(turn?.files, checkpointFilesJson);
    }),
  );

  it.effect("keeps an oversized streaming message whole for live deltas to append to", () =>
    Effect.gen(function* () {
      const thread = `mobile-records-streaming-${fixture}`;
      yield* insertThread(project, thread);
      yield* insertMessages(thread, ["question", { text: bigText, streaming: true }]);
      yield* publishProjectionState(22);

      const { selected, summary } = yield* getBaseline(thread);

      for (const view of [selected, summary]) {
        assert.equal(view.messages[1]?.streaming, true);
        assert.equal(view.messages[1]?.text, bigText);
      }
    }),
  );

  it.effect("keeps oversized pending approval and question payloads whole", () =>
    Effect.gen(function* () {
      const thread = `mobile-records-pending-${fixture}`;
      const approvalPayload = {
        requestId: `${thread}-approval`,
        requestKind: "command",
        detail: "rm -rf build",
        diff: "d".repeat(300 * KB),
      };
      const questionPayload = {
        requestId: `${thread}-question`,
        questions: [{ id: "q1", header: "Pick", question: "Which?", options: [] }],
        context: "c".repeat(300 * KB),
      };
      yield* insertThread(project, thread);
      yield* insertPendingApproval(thread, approvalPayload.requestId);
      yield* insertPendingUserInput(thread, questionPayload.requestId);
      yield* insertActivities(thread, [
        {
          id: `${thread}-approval`,
          kind: "approval.requested",
          sequence: 1,
          payload: JSON.stringify(approvalPayload),
        },
        {
          id: `${thread}-question`,
          kind: "user-input.requested",
          sequence: 2,
          payload: JSON.stringify(questionPayload),
        },
      ]);
      yield* publishProjectionState(23);

      const { selected, summary } = yield* getBaseline(thread);

      // The phone derives pending requests from these activities alone, so identical activities
      // give identical `derivePendingApprovals`/`derivePendingUserInputs` results.
      const canonical: ReadonlyArray<OrchestrationThreadActivity> = [
        { id: `${thread}-approval`, kind: "approval.requested", payload: approvalPayload, at: 1 },
        { id: `${thread}-question`, kind: "user-input.requested", payload: questionPayload, at: 2 },
      ].map((entry) => ({
        id: EventId.makeUnsafe(entry.id),
        tone: "info",
        kind: entry.kind,
        summary: entry.kind,
        payload: entry.payload,
        turnId: null,
        sequence: entry.at,
        createdAt: at(entry.at),
      }));
      assert.deepEqual(selected.activities, canonical);
      assert.deepEqual(summary.activities, canonical);
    }),
  );
});
