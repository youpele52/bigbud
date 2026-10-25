import { EventId, type OrchestrationThread, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { copyForkActivities } from "./deciderThreads.fork.logic.ts";
import { retainProjectionActivitiesAfterRevert } from "./Layers/ProjectionPipeline.helpers.ts";
import { retainThreadActivitiesAfterRevert } from "./projectorThreadState.ts";

const KEPT_TURN = TurnId.makeUnsafe("turn-1");
const activity = (id: string, kind: string, turnId: TurnId | null) => ({
  id: EventId.makeUnsafe(id),
  tone: "info" as const,
  kind,
  summary: kind,
  payload: { suggestion: "Add tests for the new parser", source: "native", provider: "codex" },
  turnId,
  createdAt: "2026-10-16T10:00:00.000Z",
});
const activities = [
  activity("tool", "tool.completed", KEPT_TURN),
  activity("suggestion", "prompt.suggestion", KEPT_TURN),
];

describe("prompt suggestion clearing", () => {
  it("drops suggestions on revert in the in-memory projector, even for retained turns", () => {
    const kept = retainThreadActivitiesAfterRevert(activities, new Set([KEPT_TURN]));
    expect(kept.map((entry) => entry.id)).toEqual(["tool"]);
  });

  it("drops suggestions on revert in the SQL projector", () => {
    const rows = activities.map(({ id, ...row }) => ({
      ...row,
      activityId: id,
      threadId: ThreadId.makeUnsafe("thread-1"),
    }));
    const kept = retainProjectionActivitiesAfterRevert(
      rows,
      [{ turnId: KEPT_TURN, checkpointTurnCount: 1 }] as never,
      1,
    );
    expect(kept.map((entry) => entry.activityId)).toEqual(["tool"]);
  });

  it("never copies a suggestion into a fork", () => {
    const source = {
      id: ThreadId.makeUnsafe("thread-1"),
      latestTurn: null,
      messages: [],
      activities,
    } as unknown as OrchestrationThread;
    const copied = copyForkActivities(ThreadId.makeUnsafe("fork-1"), source, undefined);
    expect(copied.map((entry) => entry.kind)).toEqual(["tool.completed"]);
  });
});
