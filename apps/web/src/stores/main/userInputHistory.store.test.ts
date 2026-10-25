import { expect, it } from "vitest";
import { makeActivity } from "~/logic/session/session.logic.test.helpers";
import { deriveAnsweredUserInputs } from "~/logic/session/session.userInputHistory.logic";
import { retainUserInputHistoryActivities } from "./userInputHistory.store";
import type { GetSelectedThreadDetailResult } from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import { makeThread } from "./main.store.test.helpers";
import { mergeThreadDetail } from "./mappers.lazy.store";

it("retains answered prompts when tool activity exceeds the work-log cap", () => {
  const requested = makeActivity({
    id: "prompt",
    kind: "user-input.requested",
    payload: {
      requestId: "r",
      questions: [{ id: "q", header: "Question", question: "What next?", options: [] }],
    },
  });
  const resolved = makeActivity({
    id: "answer",
    kind: "user-input.resolved",
    payload: { requestId: "r", answers: { q: "Continue" } },
  });
  const tools = Array.from({ length: 510 }, (_, i) =>
    makeActivity({ id: `tool-${i}`, kind: "tool.completed" }),
  );
  const retained = retainUserInputHistoryActivities([requested, resolved, ...tools], 500);
  expect(retained).toHaveLength(502);
  expect(deriveAnsweredUserInputs(retained)[0]?.answers).toEqual({ q: "Continue" });
  expect(retained).not.toContain(tools[0]);
});

it("merges paged question history without replacing the current turn's work log", () => {
  const currentWork = makeActivity({ id: "current-work" });
  const oldWork = makeActivity({ id: "old-work" });
  const request = makeActivity({
    id: "old-question",
    kind: "user-input.requested",
    payload: {
      requestId: "old-request",
      questions: [{ id: "q", header: "Question", question: "What next?", options: [] }],
    },
  });
  const response = makeActivity({
    id: "old-answer",
    kind: "user-input.resolved",
    payload: { requestId: "old-request", answers: { q: "Continue" } },
  });
  const thread = makeThread({ activities: [currentWork] });
  const detail: GetSelectedThreadDetailResult = {
    projectionSequence: 1,
    threadId: thread.id,
    projectId: thread.projectId,
    activityTurnId: null,
    messages: [],
    messageWindow: {
      order: "newest-first",
      requestedCursor: null,
      newestCursor: null,
      oldestCursor: null,
      nextCursor: null,
      hasOlder: false,
    },
    activities: [oldWork, request, response],
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
  };
  const merged = mergeThreadDetail(thread, detail, true);
  expect(merged.activities).toContain(currentWork);
  expect(merged.activities).not.toContain(oldWork);
  expect(deriveAnsweredUserInputs(merged.activities)[0]?.answers).toEqual({ q: "Continue" });
  expect(mergeThreadDetail(merged, detail, true).activities).toHaveLength(3);
});
