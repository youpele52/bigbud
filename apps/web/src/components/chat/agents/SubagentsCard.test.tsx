import { RuntimeTaskId, type OrchestrationTask } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  hasSubagentDetails,
  subagentStatusLabel,
  subagentTimeLabel,
  visibleSubagents,
} from "./SubagentsCard";
import { hierarchicalSubagents } from "./SubagentsCard.hierarchy";

const agent = (id: string, activityFresh = true): OrchestrationTask => ({
  id: RuntimeTaskId.makeUnsafe(id),
  kind: "providerSubagent",
  nativeId: id,
  activityFresh,
  status: "inProgress",
  subject: id,
  source: "observed",
  freshness: { sessionEpoch: "1", sourcePriority: 1, observedOrdinal: 1 },
  createdAt: "2026-09-28T12:00:00.000Z",
  updatedAt: "2026-09-28T12:00:01.000Z",
});

describe("SubagentsCard logic", () => {
  it("shows one row until expanded", () => {
    const agents = [agent("one"), agent("two")];
    expect(visibleSubagents(agents, false).map((entry) => entry.id)).toEqual(["one"]);
    expect(visibleSubagents(agents, true).map((entry) => entry.id)).toEqual(["one", "two"]);
  });

  it("labels persisted running state as last seen rather than working", () => {
    expect(subagentStatusLabel(agent("stale", false))).toBe("Last seen");
    expect(subagentStatusLabel(agent("live"))).toBe("Working");
  });

  it("groups nested agents under readable parent labels", () => {
    const parent = { ...agent("parent"), nativeId: "parent-native", subject: "Planner" };
    const child = { ...agent("child"), parentAgentId: "parent-native", subject: "Researcher" };
    expect(
      hierarchicalSubagents([child, parent]).map((row) => ({
        subject: row.agent.subject,
        depth: row.depth,
        parentLabel: row.parentLabel,
      })),
    ).toEqual([
      { subject: "Planner", depth: 0, parentLabel: undefined },
      { subject: "Researcher", depth: 1, parentLabel: "Planner" },
    ]);
  });

  it("freezes terminal duration and reports stale age from the last update", () => {
    const completed = { ...agent("done"), status: "completed" as const, activityFresh: false };
    expect(subagentTimeLabel(completed, Date.parse("2026-09-28T13:00:00.000Z"))).toBe("1s");
    const stale = { ...agent("stale", false), updatedAt: "2026-09-28T12:59:00.000Z" };
    expect(subagentTimeLabel(stale, Date.parse("2026-09-28T13:00:00.000Z"))).toBe("1m ago");
  });

  it("offers disclosure only when bounded hidden detail exists", () => {
    expect(hasSubagentDetails(agent("summary"))).toBe(false);
    expect(hasSubagentDetails({ ...agent("inline"), progressSummary: "Visible inline" })).toBe(
      false,
    );
    expect(hasSubagentDetails({ ...agent("detail"), description: "Inspect persistence" })).toBe(
      true,
    );
    expect(hasSubagentDetails({ ...agent("tool"), lastToolName: "read" })).toBe(true);
  });
});
