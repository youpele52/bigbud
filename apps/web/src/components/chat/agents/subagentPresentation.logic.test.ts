import { RuntimeTaskId, type OrchestrationTask } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  hasSubagentDetails,
  subagentActivityLine,
  subagentDisplayName,
  subagentMetricsLabel,
  subagentModelLabel,
  subagentRecentStepsLabel,
  subagentStatusIsAnimating,
  subagentStatusLabel,
  subagentStatusTone,
  subagentStepLabel,
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

const step = (toolName: string, label?: string) => ({
  toolName,
  status: "completed" as const,
  at: "2026-09-28T12:00:00Z",
  ...(label ? { label } : {}),
});

describe("subagent presentation", () => {
  it("shows one row until expanded", () => {
    const agents = [agent("one"), agent("two")];
    expect(visibleSubagents(agents, false).map((entry) => entry.id)).toEqual(["one"]);
    expect(visibleSubagents(agents, true).map((entry) => entry.id)).toEqual(["one", "two"]);
  });

  it("labels and tones every status, animating only fresh pending or running work", () => {
    const cases: Array<[Partial<OrchestrationTask>, string, string]> = [
      [{ status: "pending" }, "starting", "working"],
      [{ status: "inProgress" }, "working", "working"],
      [{ status: "inProgress", activityFresh: false }, "last seen", "warning"],
      [{ status: "stopped" }, "stopped", "warning"],
      [{ status: "completed" }, "done", "done"],
      [{ status: "failed" }, "failed", "failed"],
    ];
    for (const [overrides, label, tone] of cases) {
      const task = agent("a", overrides);
      expect(subagentStatusLabel(task)).toBe(label);
      expect(subagentStatusTone(task)).toBe(tone);
      expect(subagentStatusIsAnimating(task)).toBe(label === "starting" || label === "working");
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
  it("shows the assignment before progress arrives, across providers", () => {
    expect(subagentActivityLine(agent("explore", { description: "Find the session owner" }))).toBe(
      "Find the session owner",
    );
    expect(subagentActivityLine(agent("Review changes", { subagentType: "reviewer" }))).toBe(
      "Review changes",
    );
    expect(
      subagentActivityLine(agent("explore", { description: "Find owner", lastToolName: "Grep" })),
    ).toBe("Running Grep");
  });

  it("shows the final result or failure instead of obsolete progress", () => {
    expect(
      subagentActivityLine(
        agent("done", {
          status: "completed",
          progressSummary: "Still looking",
          resultSummary: "Found it",
        }),
      ),
    ).toBe("Found it");
    expect(
      subagentActivityLine(
        agent("failed", {
          status: "failed",
          progressSummary: "Still looking",
          terminalReason: "Permission denied",
        }),
      ),
    ).toBe("Permission denied");
  });
  it("formats only owned tool identifiers without changing progress summaries or stored names", () => {
    const raw = "bigbud_thread_v1_rename_thread";
    const running = agent("rename", { lastToolName: raw });
    expect(subagentActivityLine(running)).toBe("Running bigbud renamer");
    expect(running.lastToolName).toBe(raw);
    expect(subagentActivityLine({ ...running, status: "completed" })).toBe("Ran bigbud renamer");
    expect(subagentActivityLine({ ...running, progressSummary: `Inspect ${raw}` })).toBe(
      `Inspect ${raw}`,
    );
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

  it("drops a repeated tool prefix from step labels without losing the command", () => {
    expect(subagentStepLabel(step("Bash", "Bash: sleep 20"))).toBe("sleep 20");
    expect(subagentStepLabel(step("Bash", "bash: ls -la"))).toBe("ls -la");
    expect(subagentStepLabel(step("Bash", "Bash:"))).toBeUndefined();
    expect(subagentStepLabel(step("Read", "apps/web/src/index.css"))).toBe(
      "apps/web/src/index.css",
    );
    expect(subagentStepLabel(step("Read", "Bash: not a prefix of Read"))).toBe(
      "Bash: not a prefix of Read",
    );
    expect(subagentStepLabel(step("Grep"))).toBeUndefined();
  });

  it("counts recent steps against the reported tool total when it is consistent", () => {
    const recentSteps = [
      { toolName: "Read", status: "completed" as const, at: "2026-09-28T12:00:00Z" },
      { toolName: "Bash", status: "running" as const, at: "2026-09-28T12:00:01Z" },
    ];
    expect(subagentRecentStepsLabel(agent("a", { recentSteps, metrics: { toolUses: 29 } }))).toBe(
      "Recent steps · 2 of 29",
    );
    expect(subagentRecentStepsLabel(agent("b", { recentSteps, metrics: { toolUses: 2 } }))).toBe(
      "Recent steps · 2 of 2",
    );
    expect(subagentRecentStepsLabel(agent("d", { recentSteps, metrics: { toolUses: 1 } }))).toBe(
      "Recent steps · 2",
    );
    expect(subagentRecentStepsLabel(agent("c", { recentSteps }))).toBe("Recent steps · 2");
  });
});
