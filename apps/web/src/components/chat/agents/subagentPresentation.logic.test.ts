import { RuntimeTaskId, type OrchestrationTask } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  hasSubagentDetails,
  subagentActivityLine,
  subagentDisplayName,
  subagentMetricsLabel,
  subagentModelLabel,
  subagentStatusLabel,
  subagentStatusTone,
  subagentTimeLabel,
  visibleSubagents,
} from "./subagentPresentation.logic";

const agent = (id: string, overrides: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id: RuntimeTaskId.makeUnsafe(id),
  kind: "providerSubagent",
  nativeId: id,
  activityFresh: true,
  status: "inProgress",
  subject: id,
  source: "observed",
  freshness: { sessionEpoch: "1", sourcePriority: 1, observedOrdinal: 1 },
  createdAt: "2026-09-28T12:00:00.000Z",
  updatedAt: "2026-09-28T12:00:01.000Z",
  ...overrides,
});

describe("subagent presentation", () => {
  it("shows one row until expanded", () => {
    const agents = [agent("one"), agent("two")];
    expect(visibleSubagents(agents, false).map((entry) => entry.id)).toEqual(["one"]);
    expect(visibleSubagents(agents, true).map((entry) => entry.id)).toEqual(["one", "two"]);
  });

  it("labels and colors every status with text, never color alone", () => {
    const cases: Array<[Partial<OrchestrationTask>, string, string]> = [
      [{ status: "pending" }, "Starting", "working"],
      [{ status: "inProgress" }, "Working", "working"],
      [{ status: "inProgress", activityFresh: false }, "Last seen", "warning"],
      [{ status: "stopped" }, "Stopped", "warning"],
      [{ status: "completed" }, "Done", "done"],
      [{ status: "failed" }, "Failed", "failed"],
    ];
    for (const [overrides, label, tone] of cases) {
      expect(subagentStatusLabel(agent("a", overrides))).toBe(label);
      expect(subagentStatusTone(agent("a", overrides))).toBe(tone);
    }
  });

  it("prefers the agent type as the name and shows the model with its effort", () => {
    expect(subagentDisplayName(agent("a", { subagentType: "code-reviewer" }))).toBe(
      "code-reviewer",
    );
    expect(subagentDisplayName(agent("Review"))).toBe("Review");
    expect(subagentModelLabel(agent("a", { model: "sonnet", effort: "high" }))).toBe(
      "sonnet · high",
    );
    expect(subagentModelLabel(agent("a"))).toBeUndefined();
  });

  it("uses the summary, then the running tool, then the result as the activity line", () => {
    expect(
      subagentActivityLine(agent("a", { progressSummary: "Reading", lastToolName: "Bash" })),
    ).toBe("Reading");
    expect(subagentActivityLine(agent("a", { lastToolName: "Bash" }))).toBe("Running Bash");
    expect(
      subagentActivityLine(agent("a", { status: "completed", resultSummary: "All good" })),
    ).toBe("All good");
    expect(subagentActivityLine(agent("a"))).toBeUndefined();
  });

  it("measures terminal rows to endedAt, live rows to now and stale rows from the last update", () => {
    const now = Date.parse("2026-09-28T13:00:00.000Z");
    const done = agent("done", {
      status: "completed",
      endedAt: "2026-09-28T12:00:45.000Z",
      updatedAt: "2026-09-28T12:59:00.000Z",
    });
    expect(subagentTimeLabel(done, now)).toBe("45s");
    const legacyDone = agent("legacy", { status: "completed" });
    expect(subagentTimeLabel(legacyDone, now)).toBe("1s");
    expect(subagentTimeLabel(agent("live"), Date.parse("2026-09-28T12:02:05.000Z"))).toBe("2m");
    const stale = agent("stale", { activityFresh: false, updatedAt: "2026-09-28T12:59:00.000Z" });
    expect(subagentTimeLabel(stale, now)).toBe("1m ago");
  });

  it("formats only the metrics the provider reported", () => {
    expect(subagentMetricsLabel(undefined)).toBeUndefined();
    expect(subagentMetricsLabel({})).toBeUndefined();
    expect(
      subagentMetricsLabel({
        totalTokens: 12_300,
        toolUses: 1,
        durationMs: 65_000,
        costUsd: 0.0234,
      }),
    ).toBe("12k tokens · 1 tool · 1m 5s · $0.02");
    expect(subagentMetricsLabel({ toolUses: 3 })).toBe("3 tools");
  });

  it("offers disclosure only when hidden detail exists", () => {
    expect(hasSubagentDetails(agent("summary"))).toBe(false);
    expect(hasSubagentDetails(agent("inline", { progressSummary: "Visible inline" }))).toBe(false);
    expect(hasSubagentDetails(agent("detail", { description: "Inspect persistence" }))).toBe(true);
    expect(hasSubagentDetails(agent("tool", { lastToolName: "read" }))).toBe(true);
    expect(hasSubagentDetails(agent("prompt", { prompt: "Do it" }))).toBe(true);
    expect(
      hasSubagentDetails(
        agent("steps", {
          recentSteps: [{ toolName: "Read", status: "completed", at: "2026-09-28T12:00:00Z" }],
        }),
      ),
    ).toBe(true);
    expect(hasSubagentDetails(agent("metrics", { metrics: { toolUses: 1 } }))).toBe(true);
  });
});
