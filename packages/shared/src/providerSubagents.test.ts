import { describe, expect, it } from "vitest";

import {
  PROVIDER_SUBAGENT_LIMITS,
  PROVIDER_SUBAGENT_RECENT_STEPS_MAX,
  appendSubagentStep,
  boundSubagentText,
  completeSubagentStep,
  mergeTaskSnapshot,
  normalizeSubagentMetrics,
} from "./providerSubagents";

const at = "2026-10-16T08:00:00.000Z";

describe("boundSubagentText", () => {
  it("trims, redacts and bounds text per field", () => {
    expect(boundSubagentText("  ", "subject")).toBeUndefined();
    expect(boundSubagentText(42, "subject")).toBeUndefined();
    expect(boundSubagentText("use token=abc123 now", "prompt")).toBe("use [redacted] now");
    const long = boundSubagentText("x".repeat(500), "subject");
    expect(long).toHaveLength(PROVIDER_SUBAGENT_LIMITS.subject);
    expect(long?.endsWith("…")).toBe(true);
    expect(boundSubagentText("y".repeat(2_000), "resultSummary")).toHaveLength(1_000);
    expect(boundSubagentText("z".repeat(2_000), "progressSummary")).toHaveLength(500);
  });
});

describe("appendSubagentStep", () => {
  it("keeps a ring of the five most recent steps", () => {
    let steps = appendSubagentStep(undefined, {
      id: "t0",
      toolName: "Read",
      status: "running",
      at,
    });
    for (let index = 1; index < 8; index += 1) {
      steps = appendSubagentStep(steps, {
        id: `t${index}`,
        toolName: "Read",
        status: "running",
        at,
      });
    }
    expect(steps).toHaveLength(PROVIDER_SUBAGENT_RECENT_STEPS_MAX);
    expect(steps.map((step) => step.id)).toEqual(["t3", "t4", "t5", "t6", "t7"]);
  });

  it("deduplicates by tool-use ID, updating the step in place", () => {
    const first = appendSubagentStep([], { id: "t1", toolName: "Bash", status: "running", at });
    const second = appendSubagentStep(first, { id: "t2", toolName: "Grep", status: "running", at });
    const updated = appendSubagentStep(second, {
      id: "t1",
      toolName: "Bash",
      label: "Run tests",
      status: "completed",
      at,
    });
    expect(updated.map((step) => [step.id, step.status, step.label])).toEqual([
      ["t1", "completed", "Run tests"],
      ["t2", "running", undefined],
    ]);
  });

  it("bounds tool names and labels and drops nameless steps", () => {
    const steps = appendSubagentStep([], {
      toolName: "T".repeat(200),
      label: "L".repeat(400),
      status: "running",
      at,
    });
    expect(steps[0]?.toolName).toHaveLength(PROVIDER_SUBAGENT_LIMITS.toolName);
    expect(steps[0]?.label).toHaveLength(PROVIDER_SUBAGENT_LIMITS.label);
    expect(appendSubagentStep(steps, { toolName: "  ", status: "running", at })).toBe(steps);
  });
});

describe("completeSubagentStep", () => {
  it("completes or fails a known step and ignores unknown IDs", () => {
    const steps = appendSubagentStep([], { id: "t1", toolName: "Bash", status: "running", at });
    expect(completeSubagentStep(steps, "t1", "failed")[0]?.status).toBe("failed");
    expect(completeSubagentStep(steps, "missing", "completed")).toBe(steps);
    expect(completeSubagentStep(undefined, "t1", "completed")).toBeUndefined();
  });
});

describe("normalizeSubagentMetrics", () => {
  it("keeps finite non-negative values and returns undefined when empty", () => {
    expect(normalizeSubagentMetrics({})).toBeUndefined();
    expect(
      normalizeSubagentMetrics({
        totalTokens: 1200.7,
        toolUses: -1,
        durationMs: Number.NaN,
        costUsd: 0.25,
      }),
    ).toEqual({ totalTokens: 1200, costUsd: 0.25 });
    expect(normalizeSubagentMetrics({ toolUses: "3" })).toBeUndefined();
  });

  it("merges onto previous metrics without erasing known values", () => {
    expect(normalizeSubagentMetrics({ toolUses: 4 }, { totalTokens: 10, toolUses: 2 })).toEqual({
      totalTokens: 10,
      toolUses: 4,
    });
  });
});

describe("mergeTaskSnapshot", () => {
  it("keeps known fields and drops stale end data when a terminal task reopens", () => {
    type Snapshot = {
      status: string;
      endedAt?: string;
      resultSummary?: string;
      model?: string | undefined;
    };
    const done: Snapshot = { status: "completed", endedAt: at, resultSummary: "Done", model: "m" };
    expect(mergeTaskSnapshot(done, { status: "completed", model: undefined })).toEqual(done);
    expect(mergeTaskSnapshot(done, { status: "inProgress" })).toEqual({
      status: "inProgress",
      model: "m",
    });
    expect(
      mergeTaskSnapshot<Snapshot>(
        { status: "inProgress", model: "m" },
        { status: "completed", endedAt: at },
      ),
    ).toEqual({ status: "completed", model: "m", endedAt: at });
  });
});
