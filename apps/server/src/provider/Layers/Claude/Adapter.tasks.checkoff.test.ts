import { describe, expect, it } from "vitest";

import {
  claudeTaskPlanPayload,
  makeClaudeTaskState,
  reduceClaudeTaskState,
  reduceClaudeTasks,
} from "./Adapter.tasks.ts";

describe("Claude TodoWrite check-off compatibility", () => {
  it("projects compatible check-off statuses as completed", () => {
    const state = makeClaudeTaskState();

    reduceClaudeTasks({
      state,
      toolUseId: "tool-todo-1",
      toolName: "TodoWrite",
      value: { todos: [{ content: "Ship the fix", status: "in_progress" }] },
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
    reduceClaudeTasks({
      state,
      toolUseId: "tool-todo-2",
      toolName: "TodoWrite",
      value: { todos: [{ content: "Ship the fix", status: "done" }] },
      updatedAt: "2026-07-24T00:00:01.000Z",
    });

    expect(claudeTaskPlanPayload(state)).toEqual({
      plan: [{ step: "Ship the fix", status: "completed" }],
    });
  });

  it("removes a task when TaskUpdate marks it deleted", () => {
    const state = makeClaudeTaskState();
    reduceClaudeTasks({
      state,
      toolUseId: "tool-create",
      toolName: "TaskCreate",
      value: { task_id: "task-1", subject: "Temporary task", status: "pending" },
      updatedAt: "2026-07-24T00:00:00.000Z",
    });

    const reduction = reduceClaudeTaskState({
      state,
      toolUseId: "tool-update",
      toolName: "TaskUpdate",
      value: { taskId: "task-1", status: "deleted" },
      updatedAt: "2026-07-24T00:00:01.000Z",
    });

    expect(reduction.removedTaskIds).toEqual(["task-1"]);
    expect(claudeTaskPlanPayload(state, true)).toEqual({ plan: [] });
  });

  it("ignores a stale task deletion after a newer update", () => {
    const state = makeClaudeTaskState();
    reduceClaudeTasks({
      state,
      toolUseId: "tool-create",
      toolName: "TaskCreate",
      value: { task_id: "task-1", subject: "Keep this task", status: "completed" },
      updatedAt: "2026-07-24T00:00:02.000Z",
    });

    const reduction = reduceClaudeTaskState({
      state,
      toolUseId: "tool-delete",
      toolName: "TaskUpdate",
      value: { task_id: "task-1", status: "deleted" },
      updatedAt: "2026-07-24T00:00:01.000Z",
    });

    expect(reduction.removedTaskIds).toEqual([]);
    expect(state.tasks.get("task-1")).toMatchObject({ status: "completed" });
  });
});
