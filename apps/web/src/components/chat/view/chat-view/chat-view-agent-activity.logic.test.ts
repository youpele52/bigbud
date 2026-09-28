import { RuntimeTaskId, type OrchestrationTask } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { resolveAgentActivityPresentation } from "./chat-view-agent-activity.logic";

function child(activityFresh: boolean): OrchestrationTask {
  return {
    id: RuntimeTaskId.makeUnsafe("child"),
    kind: "providerSubagent",
    activityFresh,
    status: "inProgress",
    subject: "Child",
    source: "observed",
    freshness: { sessionEpoch: "1", sourcePriority: 1, observedOrdinal: 1 },
    createdAt: "2026-09-28T12:00:00.000Z",
    updatedAt: "2026-09-28T12:00:01.000Z",
  };
}

describe("resolveAgentActivityPresentation", () => {
  it("always gives main activity precedence", () => {
    expect(
      resolveAgentActivityPresentation({
        mainActive: true,
        mainVerb: "Thinking",
        agents: [child(true)],
      }),
    ).toMatchObject({ visible: true, tone: "main", verb: "Thinking" });
  });

  it("shows fresh child-only activity without treating stale persisted state as live", () => {
    expect(
      resolveAgentActivityPresentation({
        mainActive: false,
        mainVerb: "Thinking",
        agents: [child(true)],
      }),
    ).toMatchObject({ visible: true, tone: "subagent", verb: "1 subagent working" });
    expect(
      resolveAgentActivityPresentation({
        mainActive: false,
        mainVerb: "Thinking",
        agents: [child(false)],
      }),
    ).toMatchObject({ visible: false });
  });
});
