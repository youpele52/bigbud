import { describe, expect, it } from "vitest";

import { reduceClaudeTaskState } from "./Adapter.tasks.reducer.ts";
import { makeClaudeTaskState } from "./Adapter.tasks.types.ts";

const apply = (
  state: ReturnType<typeof makeClaudeTaskState>,
  value: Record<string, unknown>,
  second: number,
  toolName = "task_updated",
) =>
  reduceClaudeTaskState({
    state,
    toolUseId: `event-${second}`,
    toolName,
    value: { task_id: "child", description: "Review", ...value },
    turnId: `turn-${second}`,
    updatedAt: `2026-11-05T00:00:0${second}.000Z`,
  });

describe("Claude background task ownership", () => {
  it.each([undefined, "running", "completed", "done", "complete", "error", "interrupted"])(
    "rejects previously unseen older run frames (%s) using the SDK ordering guarantee",
    (status) => {
      const state = makeClaudeTaskState();
      apply(state, { run_id: "b-current", status: "running" }, 1);
      apply(state, { run_id: "a-older", ...(status ? { status } : {}) }, 2);
      expect(state.tasks.get("child")).toMatchObject({ runId: "b-current", status: "inProgress" });
      apply(state, { run_id: "b-current", status: "completed" }, 3);
      expect(state.tasks.get("child")?.status).toBe("completed");
    },
  );

  it.each(["task_updated", "task_notification", "background_tasks_changed"])(
    "recovers a newer run with a missed start from %s",
    (toolName) => {
      const state = makeClaudeTaskState();
      apply(
        state,
        {
          run_id: "run-1",
          status: "completed",
          result_summary: "old result",
          usage: { totalTokens: 99 },
          metrics: { totalTokens: 99 },
        },
        1,
      );
      const record = {
        task_id: "child",
        description: "Review",
        run_id: "run-2",
        ...(toolName === "background_tasks_changed"
          ? {}
          : { status: "completed", result_summary: "new result" }),
      };
      apply(
        state,
        toolName === "background_tasks_changed" ? { tasks: [record] } : record,
        2,
        toolName,
      );
      expect(state.tasks.get("child")).toMatchObject({
        runId: "run-2",
        turnId: "turn-2",
        status: toolName === "background_tasks_changed" ? "inProgress" : "completed",
      });
      expect(state.tasks.get("child")?.usage).toBeUndefined();
      expect(state.tasks.get("child")?.metrics).toBeUndefined();
      apply(state, { run_id: "run-1", status: "failed" }, 3);
      expect(state.tasks.get("child")?.runId).toBe("run-2");
    },
  );

  it("clears prior settlement on a newer active run and rejects delayed/repeated frames", () => {
    const state = makeClaudeTaskState();
    apply(
      state,
      {
        run_id: "run-1",
        status: "completed",
        result_summary: "old result",
        terminal_reason: "old failure",
        usage: { totalTokens: 99 },
        metrics: { totalTokens: 99 },
      },
      1,
    );
    const active = { run_id: "run-2", status: "running" };
    apply(state, active, 2);
    expect(state.tasks.get("child")).toMatchObject({ status: "inProgress", turnId: "turn-2" });
    for (const key of ["resultSummary", "endedAt", "terminalReason", "usage", "metrics"] as const) {
      expect(state.tasks.get("child")?.[key]).toBeUndefined();
    }
    apply(state, { run_id: "run-1", status: "completed" }, 3);
    apply(state, active, 4);
    expect(state.tasks.get("child")).toMatchObject({
      runId: "run-2",
      status: "inProgress",
      turnId: "turn-2",
    });
  });

  it("keeps the launching turn through progress and completion during a later turn", () => {
    const state = makeClaudeTaskState();
    apply(state, { run_id: "run-1", status: "running" }, 1);
    apply(state, { run_id: "run-1", status: "running", progress_summary: "still working" }, 2);
    expect(state.tasks.get("child")?.turnId).toBe("turn-1");
    apply(state, { run_id: "run-1", status: "completed" }, 3);
    expect(state.tasks.get("child")).toMatchObject({ turnId: "turn-1", status: "completed" });
    apply(state, { run_id: "run-2", status: "running" }, 4);
    expect(state.tasks.get("child")).toMatchObject({ turnId: "turn-4", status: "inProgress" });
  });
});
