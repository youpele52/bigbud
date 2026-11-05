import { describe, expect, it } from "vitest";

import { reduceClaudeTaskState } from "./Adapter.tasks.reducer.ts";
import { makeClaudeTaskState } from "./Adapter.tasks.types.ts";

describe("Claude background task ownership", () => {
  it("keeps the launching turn through progress and completion during a later turn", () => {
    const state = makeClaudeTaskState();
    const apply = (status: string, turnId: string, second: number, runId = "run-1") =>
      reduceClaudeTaskState({
        state,
        toolUseId: `event-${second}`,
        toolName: "task_updated",
        value: {
          task_id: "child",
          description: "Review",
          task_type: "local_agent",
          status,
          run_id: runId,
        },
        turnId,
        updatedAt: `2026-10-25T00:00:0${second}.000Z`,
      });
    apply("running", "root-1", 1);
    apply("running", "root-2", 2);
    expect(state.tasks.get("child")?.turnId).toBe("root-1");
    apply("completed", "root-2", 3);
    expect(state.tasks.get("child")).toMatchObject({ turnId: "root-1", status: "completed" });
    // An explicit newer native run may acquire a new launching turn.
    apply("running", "root-2", 4, "run-2");
    expect(state.tasks.get("child")).toMatchObject({ turnId: "root-2", status: "inProgress" });
  });
});
