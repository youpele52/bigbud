import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  THREAD_DETAIL_ACTIVITY_DEFAULT_LIMIT,
  THREAD_DETAIL_CHECKPOINT_DEFAULT_LIMIT,
  THREAD_DETAIL_MESSAGE_DEFAULT_LIMIT,
  THREAD_DETAIL_PAGE_TEXT_BUDGET,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import { assert } from "@effect/vitest";
import { Effect } from "effect";

import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  insertActivities,
  insertCheckpointTurn,
  insertMessages,
  insertPendingApproval,
  insertProject,
  insertProposedPlan,
  insertThread,
  publishProjectionState,
  type ActivitySeed,
} from "./ProjectionSnapshotQuery.mobile.bounds.fixtures.ts";
import { MOBILE_SELECTED_PROPOSED_PLAN_LIMIT } from "./ProjectionSnapshotQuery.mobileSql.ts";
import { projectionSnapshotLayer } from "./ProjectionSnapshotQuery.test.helpers.ts";

const fixture = crypto.randomUUID();
const project = `mobile-bounds-project-${fixture}`;
const KB = 1024;

const getBaseline = Effect.fn("getBaseline")(function* (threadId: string) {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const baseline = yield* snapshotQuery.getMobileRecoveryBaseline!(ThreadId.makeUnsafe(threadId));
  const selected = baseline.selectedThread;
  assert.equal(selected?.status, "present");
  return {
    baseline,
    selected: selected?.status === "present" ? selected : null,
    summaryOf: (id: string) => baseline.snapshot.threads.find((thread) => thread.id === id),
  };
});

const seriesOf = (count: number, make: (index: number) => ActivitySeed) =>
  Array.from({ length: count }, (_, index) => make(index + 1));

projectionSnapshotLayer("ProjectionSnapshotQuery.mobile.bounds", (it) => {
  it.effect("caps selected messages at the detail window and flags older history", () =>
    Effect.gen(function* () {
      const thread = `mobile-bounds-many-${fixture}`;
      yield* insertProject(project);
      yield* insertThread(project, thread);
      yield* insertMessages(
        thread,
        Array.from({ length: 60 }, (_, index) => `text-${index + 1}`),
      );
      yield* publishProjectionState(11);

      const { baseline, selected, summaryOf } = yield* getBaseline(thread);

      assert.equal(baseline.snapshotSequence, 11);
      assert.equal(baseline.snapshot.snapshotSequence, 11);
      assert.equal(selected?.hasOlderHistory, true);
      assert.equal(selected?.thread.messages.length, THREAD_DETAIL_MESSAGE_DEFAULT_LIMIT);
      assert.deepEqual(
        selected?.thread.messages.map((message) => message.text),
        Array.from({ length: 50 }, (_, index) => `text-${index + 11}`),
      );
      assert.deepEqual(
        summaryOf(thread)?.messages.map((message) => message.text),
        ["text-57", "text-58", "text-59", "text-60"],
      );
    }),
  );

  it.effect("drops the oldest messages over the text budget but always keeps the newest", () =>
    Effect.gen(function* () {
      const withinWindow = `mobile-bounds-budget-${fixture}`;
      const oversized = `mobile-bounds-oversized-${fixture}`;
      yield* insertThread(project, withinWindow);
      yield* insertThread(project, oversized);
      yield* insertMessages(withinWindow, [
        "oldest",
        "a".repeat(200 * KB),
        "b".repeat(200 * KB),
        "c".repeat(200 * KB),
      ]);
      // Streaming, so the record bound keeps it whole and only the page budget applies.
      yield* insertMessages(oversized, [
        "older",
        { text: "z".repeat(THREAD_DETAIL_PAGE_TEXT_BUDGET + KB), streaming: true },
      ]);
      yield* publishProjectionState(12);

      const budget = yield* getBaseline(withinWindow);
      assert.equal(budget.baseline.snapshotSequence, 12);
      assert.equal(budget.selected?.hasOlderHistory, true);
      assert.deepEqual(
        budget.selected?.thread.messages.map((message) => message.text[0]),
        ["b", "c"],
      );

      const single = yield* getBaseline(oversized);
      assert.equal(single.selected?.hasOlderHistory, true);
      assert.deepEqual(
        single.selected?.thread.messages.map((message) => message.text.length),
        [THREAD_DETAIL_PAGE_TEXT_BUDGET + KB],
      );
    }),
  );

  it.effect("returns a thread under every limit unchanged without the flag", () =>
    Effect.gen(function* () {
      const thread = `mobile-bounds-small-${fixture}`;
      yield* insertThread(project, thread, "small-turn-2");
      yield* insertMessages(thread, ["one", "two", "three", "four", "five"]);
      yield* insertActivities(
        thread,
        seriesOf(3, (index) => ({
          id: `${thread}-activity-${index}`,
          kind: "tool.progress",
          sequence: index,
        })),
      );
      yield* insertCheckpointTurn(thread, "small-turn-1", 1);
      yield* insertCheckpointTurn(thread, "small-turn-2", 2);
      yield* insertProposedPlan(thread, `${thread}-plan-1`, "small-turn-1", 1);
      yield* insertProposedPlan(thread, `${thread}-plan-2`, "small-turn-2", 2);
      yield* publishProjectionState(13);

      const { baseline, selected } = yield* getBaseline(thread);
      assert.equal(baseline.snapshotSequence, 13);
      assert.isUndefined(selected?.hasOlderHistory);
      assert.deepEqual(
        selected?.thread.messages.map((message) => message.text),
        ["one", "two", "three", "four", "five"],
      );
      assert.equal(selected?.thread.activities.length, 3);
      assert.deepEqual(
        selected?.thread.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount),
        [1, 2],
      );
      assert.deepEqual(
        selected?.thread.proposedPlans.map((plan) => plan.id),
        [`${thread}-plan-1`, `${thread}-plan-2`],
      );
    }),
  );

  it.effect("caps selected and latest-turn activities while keeping pending approvals", () =>
    Effect.gen(function* () {
      const thread = `mobile-bounds-activities-${fixture}`;
      const busy = `mobile-bounds-busy-${fixture}`;
      yield* insertThread(project, thread);
      yield* insertThread(project, busy, "busy-turn");
      yield* insertCheckpointTurn(busy, "busy-turn", 1);
      yield* insertPendingApproval(thread, `${thread}-request`);
      yield* insertActivities(thread, [
        {
          id: `${thread}-pending`,
          kind: "approval.requested",
          sequence: 1,
          payload: JSON.stringify({ requestId: `${thread}-request` }),
        },
        ...seriesOf(30, (index) => ({
          id: `${thread}-resolved-${index}`,
          kind: "approval.resolved",
          sequence: index + 1,
        })),
        ...seriesOf(150, (index) => ({
          id: `${thread}-tool-${index}`,
          kind: "tool.progress",
          sequence: index + 31,
        })),
      ]);
      yield* insertActivities(
        busy,
        seriesOf(130, (index) => ({
          id: `${busy}-tool-${index}`,
          kind: "tool.progress",
          sequence: index,
          turnId: "busy-turn",
        })),
      );
      yield* publishProjectionState(14);

      const { baseline, selected, summaryOf } = yield* getBaseline(thread);
      const activities = selected?.thread.activities ?? [];
      const tools = activities.filter((activity) => activity.kind === "tool.progress");
      const resolved = activities.filter((activity) => activity.kind === "approval.resolved");

      assert.equal(baseline.snapshotSequence, 14);
      assert.equal(tools.length, THREAD_DETAIL_ACTIVITY_DEFAULT_LIMIT);
      assert.equal(tools[0]?.sequence, 82);
      assert.equal(resolved.length, 20);
      assert.equal(resolved[0]?.sequence, 12);
      assert.isTrue(activities.some((activity) => activity.id === `${thread}-pending`));
      assert.equal(activities.length, THREAD_DETAIL_ACTIVITY_DEFAULT_LIMIT + 20 + 1);

      const busyActivities = summaryOf(busy)?.activities ?? [];
      assert.equal(busyActivities.length, THREAD_DETAIL_ACTIVITY_DEFAULT_LIMIT);
      assert.equal(busyActivities[0]?.sequence, 31);
      assert.equal(busyActivities.at(-1)?.sequence, 130);
    }),
  );

  it.effect("caps selected proposed plans and checkpoints in their original order", () =>
    Effect.gen(function* () {
      const thread = `mobile-bounds-plans-${fixture}`;
      yield* insertThread(project, thread, "plan-turn-15");
      for (let count = 1; count <= 15; count += 1) {
        yield* insertCheckpointTurn(thread, `plan-turn-${count}`, count);
        yield* insertProposedPlan(
          thread,
          `${thread}-old-${count}`,
          `old-turn-${count}`,
          count + 10,
        );
      }
      yield* insertProposedPlan(thread, `${thread}-latest-a`, "plan-turn-15", 1);
      yield* insertProposedPlan(thread, `${thread}-latest-b`, "plan-turn-15", 2);
      yield* publishProjectionState(15);

      const { baseline, selected } = yield* getBaseline(thread);
      const recentPlans = Array.from(
        { length: MOBILE_SELECTED_PROPOSED_PLAN_LIMIT },
        (_, index) => `${thread}-old-${index + 6}`,
      );

      assert.equal(baseline.snapshotSequence, 15);
      assert.deepEqual(
        selected?.thread.proposedPlans.map((plan) => plan.id),
        [`${thread}-latest-a`, `${thread}-latest-b`, ...recentPlans],
      );
      assert.deepEqual(
        selected?.thread.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount),
        Array.from({ length: THREAD_DETAIL_CHECKPOINT_DEFAULT_LIMIT }, (_, index) => index + 6),
      );
    }),
  );
});
