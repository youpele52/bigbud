import { RuntimeTaskId, type OrchestrationTask } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

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

describe("SubagentsCard hierarchy", () => {
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

  it("nests by native parent task ID and caps the visual depth input", () => {
    const root = { ...agent("root"), subject: "Root" };
    const child = {
      ...agent("child"),
      parentTaskId: RuntimeTaskId.makeUnsafe("root"),
      subject: "Child",
    };
    const grandchild = { ...agent("grandchild"), parentAgentId: "child", subject: "Grandchild" };
    expect(
      hierarchicalSubagents([grandchild, child, root]).map((row) => [row.agent.id, row.depth]),
    ).toEqual([
      ["root", 0],
      ["child", 1],
      ["grandchild", 2],
    ]);
  });

  it("treats a parent cycle as roots instead of looping", () => {
    const a = { ...agent("a"), parentAgentId: "b" };
    const b = { ...agent("b"), parentAgentId: "a" };
    expect(
      hierarchicalSubagents([a, b])
        .map((row) => row.agent.id)
        .toSorted(),
    ).toEqual(["a", "b"]);
  });
});
