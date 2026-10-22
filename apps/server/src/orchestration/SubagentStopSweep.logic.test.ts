import { isTaskFreshnessNewer } from "@bigbud/shared/providerRuntime";
import { describe, expect, it } from "vitest";

import {
  buildStoppedSubagentSnapshot,
  selectRunningSubagents,
  stillRunningTargets,
  SUBAGENT_STOPPED_WITH_THREAD_REASON,
} from "./SubagentStopSweep.logic.ts";
import { subagentTask } from "./SubagentStopSweep.test.helpers.ts";

const REQUESTED_AT = "2026-10-21T10:00:00.000Z";

describe("selectRunningSubagents", () => {
  it("keeps running subagents, foreground and background, that existed at Stop", () => {
    const tasks = [
      subagentTask("running"),
      subagentTask("pending", { status: "pending" }),
      subagentTask("background", { background: true }),
      subagentTask("done", { status: "completed" }),
      subagentTask("ordinary", { kind: "task" }),
      subagentTask("newer-turn", { createdAt: "2026-10-21T10:00:01.000Z" }),
    ];

    expect(selectRunningSubagents(tasks, REQUESTED_AT).map((task) => task.id)).toEqual([
      "running",
      "pending",
      "background",
    ]);
  });
});

describe("stillRunningTargets", () => {
  it("drops targets the provider settled and tasks that were never targets", () => {
    const tasks = [
      subagentTask("a"),
      subagentTask("b", { status: "stopped" }),
      subagentTask("c", { status: "failed" }),
      subagentTask("d"),
    ];

    expect(stillRunningTargets(tasks, new Set(["a", "b", "c"])).map((task) => task.id)).toEqual([
      "a",
    ]);
  });
});

describe("buildStoppedSubagentSnapshot", () => {
  it("marks the row stopped with an end time and reason, keeping every other field", () => {
    const task = subagentTask("a", { prompt: "Do the thing", lastToolName: "Bash" });
    const stopped = buildStoppedSubagentSnapshot(task, "2026-10-21T10:00:03.000Z");

    expect(stopped).toEqual({
      ...task,
      status: "stopped",
      activityFresh: false,
      endedAt: "2026-10-21T10:00:03.000Z",
      terminalReason: SUBAGENT_STOPPED_WITH_THREAD_REASON,
      freshness: { ...task.freshness, observedOrdinal: 8 },
      updatedAt: "2026-10-21T10:00:03.000Z",
    });
  });

  it("keeps a provider-reported end time and reason", () => {
    const task = subagentTask("a", {
      endedAt: "2026-10-21T10:00:01.000Z",
      terminalReason: "Cancelled",
    });
    const stopped = buildStoppedSubagentSnapshot(task, "2026-10-21T10:00:03.000Z");

    expect(stopped.endedAt).toBe("2026-10-21T10:00:01.000Z");
    expect(stopped.terminalReason).toBe("Cancelled");
  });

  it("wins over the stored update but loses to a newer provider update", () => {
    const task = subagentTask("a", {
      freshness: {
        sessionEpoch: "1",
        sourcePriority: 3,
        providerTimestamp: "2026-10-21T09:59:30.000Z",
        observedOrdinal: 7,
      },
    });
    const stopped = buildStoppedSubagentSnapshot(task, "2026-10-21T10:00:03.000Z");

    expect(isTaskFreshnessNewer(stopped.freshness, task.freshness)).toBe(true);
    expect(
      isTaskFreshnessNewer(
        { ...task.freshness, providerTimestamp: "2026-10-21T10:00:05.000Z", observedOrdinal: 9 },
        stopped.freshness,
      ),
    ).toBe(true);
  });
});
