import { EventId, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { RuntimeActivityGovernor } from "./ProviderRuntimeIngestion.activityGovernor.ts";
import {
  toolActivity,
  toolItem,
  turnCompleted,
  turnStarted,
  upsertActivities,
} from "./ProviderTurnSupervisor.runtimeEvents.test.helpers.ts";
import {
  findToolItemsInFlight,
  toolsInFlightForTurn,
  trackTurnToolEvent,
  UNRECORDED_TOOL_LABEL,
  type TurnToolTracking,
} from "./ProviderTurnSupervisor.tools.logic.ts";

const threadId = ThreadId.makeUnsafe("tools-thread");
const turnId = TurnId.makeUnsafe("tools-turn");
const since = "2026-10-22T09:59:00.000Z";

/** 21 tools that started and completed, then a 22nd that started: past the 40-row budget. */
function longTurnActivities(lastTool: string) {
  const governor = new RuntimeActivityGovernor();
  const rows = [];
  for (let index = 0; index < 21; index += 1) {
    for (const kind of ["tool.started", "tool.completed"] as const) {
      rows.push(toolActivity({ kind, title: `Step ${index}`, itemId: `item-${index}`, turnId }));
    }
  }
  rows.push(toolActivity({ kind: "tool.started", title: lastTool, itemId: "item-last", turnId }));
  return upsertActivities(governor.take({ threadId, turnId, activities: rows }));
}

function trackingOf(events: ReadonlyArray<Parameters<typeof trackTurnToolEvent>[1]>) {
  const map = new Map<ThreadId, TurnToolTracking>();
  for (const event of events) trackTurnToolEvent(map, event, 16);
  return map.get(threadId);
}

describe("tools in flight across the activity governor", () => {
  it("the governor drops a late tool start, and the suppressed row counts as in flight", () => {
    const activities = longTurnActivities("Deploy");
    expect(activities.some((row) => row.summary === "Deploy started")).toBe(false);
    expect(findToolItemsInFlight(activities, turnId)).toEqual([]);
    expect(toolsInFlightForTurn({ activities, turnId, since, tracking: undefined })).toEqual([
      UNRECORDED_TOOL_LABEL,
    ]);
  });

  it("the coordinator's own tracking names the tool the governor dropped", () => {
    const events = [turnStarted(threadId, turnId)];
    for (let index = 0; index < 21; index += 1) {
      events.push(toolItem("item.started", threadId, turnId, `item-${index}`, `Step ${index}`));
      events.push(toolItem("item.completed", threadId, turnId, `item-${index}`, `Step ${index}`));
    }
    events.push(toolItem("item.started", threadId, turnId, "item-last", "Deploy"));
    expect(
      toolsInFlightForTurn({
        activities: longTurnActivities("Deploy"),
        turnId,
        since,
        tracking: trackingOf(events),
      }),
    ).toEqual(["Deploy"]);
  });

  it("does not ask when tracking saw the whole turn and every tool completed", () => {
    const events = [turnStarted(threadId, turnId)];
    for (let index = 0; index < 22; index += 1) {
      events.push(toolItem("item.started", threadId, turnId, `item-${index}`, `Step ${index}`));
      events.push(toolItem("item.completed", threadId, turnId, `item-${index}`, `Step ${index}`));
    }
    const activities = upsertActivities([
      ...longTurnActivities("Step 21"),
      toolActivity({ kind: "tool.completed", title: "Step 21", itemId: "item-last", turnId }),
    ]);
    expect(
      toolsInFlightForTurn({ activities, turnId, since, tracking: trackingOf(events) }),
    ).toEqual([]);
    // Tracking that joined mid-turn cannot vouch for the dropped rows.
    const partial = trackingOf(events.slice(1));
    expect(toolsInFlightForTurn({ activities, turnId, since, tracking: partial })).toEqual([
      UNRECORDED_TOOL_LABEL,
    ]);
  });
});

describe("tool activity scope", () => {
  it("counts a tool start without a turn ID only when it came after the turn was requested", () => {
    const late = toolActivity({
      kind: "tool.started",
      title: "Unscoped",
      itemId: "u",
      turnId: null,
      createdAt: "2026-10-22T10:00:00.000Z",
    });
    const early = {
      ...late,
      id: EventId.makeUnsafe("early"),
      createdAt: "2026-10-22T09:00:00.000Z",
    };
    expect(findToolItemsInFlight([late, early], turnId, { since })).toEqual([
      { itemId: "u", name: "Unscoped" },
    ]);
    expect(findToolItemsInFlight([late], turnId)).toEqual([]);
  });

  it("tracks the turn's end and starts over at the next turn", () => {
    const next = TurnId.makeUnsafe("next-turn");
    const tracking = trackingOf([
      turnStarted(threadId, turnId),
      toolItem("item.started", threadId, turnId, "a", "Bash"),
      turnCompleted(threadId, turnId, "failed"),
    ]);
    expect(tracking?.ended).toBe(true);
    expect([...(tracking?.open.values() ?? [])]).toEqual(["Bash"]);
    const after = trackingOf([
      turnStarted(threadId, turnId),
      toolItem("item.started", threadId, turnId, "a", "Bash"),
      turnStarted(threadId, next),
    ]);
    expect(after?.turnId).toBe(next);
    expect(after?.open.size).toBe(0);
  });
});
