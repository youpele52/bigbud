import { describe, expect, it } from "vitest";

import {
  claudeTaskPlanPayload,
  makeClaudeTaskState,
  reduceClaudeTaskState,
  reduceClaudeTasks,
} from "./Adapter.tasks.ts";

describe("Claude task reducer", () => {
  it("promotes a provisional TaskCreate record when its durable ID arrives", () => {
    const state = makeClaudeTaskState();

    expect(
      reduceClaudeTasks({
        state,
        toolUseId: "tool-create",
        toolName: "TaskCreate",
        value: { subject: "Implement task reducer", status: "pending" },
        updatedAt: "2026-07-24T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      reduceClaudeTasks({
        state,
        toolUseId: "tool-create",
        toolName: "TaskCreate",
        value: { task_id: "task-1", subject: "Implement task reducer", status: "running" },
        updatedAt: "2026-07-24T00:00:01.000Z",
      }),
    ).toBe(true);

    expect(Array.from(state.tasks.keys())).toEqual(["task-1"]);
    expect(claudeTaskPlanPayload(state)).toEqual({
      plan: [{ step: "Implement task reducer", status: "inProgress" }],
    });
  });

  it("keeps existing tasks and ignores repeated updates", () => {
    const state = makeClaudeTaskState();
    const update = {
      state,
      toolUseId: "tool-update",
      toolName: "TaskUpdate",
      value: { task_id: "task-1", subject: "First task", status: "completed" },
      updatedAt: "2026-07-24T00:00:00.000Z",
    } as const;

    reduceClaudeTasks({
      ...update,
      toolName: "TaskCreate",
      toolUseId: "tool-create",
      value: { task_id: "task-2", subject: "Second task", status: "pending" },
    });
    expect(reduceClaudeTasks(update)).toBe(true);
    expect(reduceClaudeTasks(update)).toBe(false);

    expect(claudeTaskPlanPayload(state)).toEqual({
      plan: [
        { step: "Second task", status: "pending" },
        { step: "First task", status: "completed" },
      ],
    });
  });

  it("reconciles a TaskList snapshot and keeps failed tasks non-active", () => {
    const state = makeClaudeTaskState();

    expect(
      reduceClaudeTasks({
        state,
        toolUseId: "tool-list",
        toolName: "TaskList",
        value: {
          tasks: [
            { id: "task-1", subject: "Ready task", status: "queued" },
            { id: "task-2", subject: "Stopped task", status: "cancelled" },
          ],
        },
        updatedAt: "2026-07-24T00:00:00.000Z",
      }),
    ).toBe(true);

    expect(claudeTaskPlanPayload(state)).toEqual({
      plan: [
        { step: "Ready task", status: "pending" },
        { step: "Stopped task", status: "pending" },
      ],
    });
  });

  it("removes TaskList entries omitted by a later authoritative snapshot", () => {
    const state = makeClaudeTaskState();

    reduceClaudeTasks({
      state,
      toolUseId: "tool-list-1",
      toolName: "TaskList",
      authoritativeSnapshot: true,
      value: {
        tasks: [
          { id: "task-1", subject: "First", status: "pending" },
          { id: "task-2", subject: "Second", status: "running" },
        ],
      },
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
    const reduction = reduceClaudeTaskState({
      state,
      toolUseId: "tool-list-2",
      toolName: "TaskList",
      authoritativeSnapshot: true,
      value: { tasks: [{ id: "task-2", subject: "Second", status: "completed" }] },
      updatedAt: "2026-07-24T00:00:01.000Z",
    });

    expect(reduction.removedTaskIds).toEqual(["task-1"]);
    expect(Array.from(state.tasks.keys())).toEqual(["task-2"]);
    expect(claudeTaskPlanPayload(state)).toEqual({
      plan: [{ step: "Second", status: "completed" }],
    });
  });

  it("does not remove TaskList members from a parseable partial snapshot", () => {
    const state = makeClaudeTaskState();

    reduceClaudeTasks({
      state,
      toolUseId: "tool-list",
      toolName: "TaskList",
      authoritativeSnapshot: true,
      value: {
        tasks: [
          { id: "task-1", subject: "First", status: "pending" },
          { id: "task-2", subject: "Second", status: "pending" },
        ],
      },
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
    reduceClaudeTasks({
      state,
      toolUseId: "tool-list",
      toolName: "TaskList",
      value: { tasks: [{ id: "task-1", subject: "First", status: "running" }] },
      updatedAt: "2026-07-24T00:00:01.000Z",
    });

    expect(Array.from(state.tasks.keys())).toEqual(["task-1", "task-2"]);
  });

  it("replaces background membership without deleting overlapping TaskList tasks", () => {
    const state = makeClaudeTaskState();

    reduceClaudeTasks({
      state,
      toolUseId: "tool-list",
      toolName: "TaskList",
      authoritativeSnapshot: true,
      value: { tasks: [{ id: "task-1", subject: "Tracked task", status: "pending" }] },
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
    reduceClaudeTasks({
      state,
      toolUseId: "background-1",
      toolName: "background_tasks_changed",
      value: {
        uuid: "background-message-1",
        tasks: [
          { task_id: "task-1", task_type: "agent", description: "Tracked task" },
          { task_id: "task-2", task_type: "bash", description: "Background only" },
        ],
      },
      updatedAt: "2026-07-24T00:00:01.000Z",
    });
    const reduction = reduceClaudeTaskState({
      state,
      toolUseId: "background-2",
      toolName: "background_tasks_changed",
      value: { uuid: "background-message-2", tasks: [] },
      updatedAt: "2026-07-24T00:00:02.000Z",
    });

    expect(reduction.removedTaskIds).toEqual(["task-2"]);
    expect(state.tasks.get("task-1")).toMatchObject({
      subject: "Tracked task",
      status: "pending",
      taskListMember: true,
      backgroundMember: false,
    });
    expect(state.tasks.has("task-2")).toBe(false);
  });

  it("deduplicates repeated native snapshot messages by UUID", () => {
    const state = makeClaudeTaskState();
    const input = {
      state,
      toolUseId: "background",
      toolName: "background_tasks_changed",
      value: {
        uuid: "background-message",
        tasks: [{ task_id: "task-1", task_type: "agent", description: "Background task" }],
      },
      updatedAt: "2026-07-24T00:00:00.000Z",
    } as const;

    expect(reduceClaudeTaskState(input).changed).toBe(true);
    expect(reduceClaudeTaskState({ ...input, updatedAt: "2026-07-24T00:00:01.000Z" })).toEqual({
      changedTaskIds: [],
      removedTaskIds: [],
      changed: false,
    });
  });

  it("does not regress terminal tasks from a later task_updated active patch", () => {
    const state = makeClaudeTaskState();

    reduceClaudeTasks({
      state,
      toolUseId: "tool-create",
      toolName: "TaskCreate",
      value: { task_id: "task-1", subject: "Terminal task", status: "completed" },
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
    reduceClaudeTasks({
      state,
      toolUseId: "task-1",
      toolName: "task_updated",
      value: {
        uuid: "task-update-message",
        task_id: "task-1",
        patch: { status: "running", description: "Stale running update" },
      },
      updatedAt: "2026-07-24T00:00:01.000Z",
    });

    expect(state.tasks.get("task-1")).toMatchObject({
      status: "completed",
      nativeStatus: "completed",
    });
  });

  it("keeps legacy TodoWrite snapshots idempotent and removes stale todo entries", () => {
    const state = makeClaudeTaskState();
    const firstSnapshot = {
      state,
      toolUseId: "tool-todo-1",
      toolName: "TodoWrite",
      value: {
        todos: [
          { content: "First task", status: "in_progress" },
          { content: "Second task", status: "pending" },
        ],
      },
      updatedAt: "2026-07-24T00:00:00.000Z",
    } as const;

    expect(reduceClaudeTasks(firstSnapshot)).toBe(true);
    expect(
      reduceClaudeTasks({
        ...firstSnapshot,
        updatedAt: "2026-07-24T00:00:01.000Z",
      }),
    ).toBe(false);
    expect(
      reduceClaudeTasks({
        ...firstSnapshot,
        value: { todos: [{ status: "completed" }, { status: "completed" }] },
        updatedAt: "2026-07-24T00:00:02.000Z",
      }),
    ).toBe(true);

    expect(claudeTaskPlanPayload(state)).toEqual({
      plan: [
        { step: "First task", status: "completed" },
        { step: "Second task", status: "completed" },
      ],
    });
  });

  it("merges TaskUpdate results and SDK task_updated patches", () => {
    const state = makeClaudeTaskState();

    reduceClaudeTasks({
      state,
      toolUseId: "tool-create",
      toolName: "TaskCreate",
      value: { task_id: "task-1", subject: "Implement reducer", status: "pending" },
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
    expect(
      reduceClaudeTasks({
        state,
        toolUseId: "tool-update",
        toolName: "TaskUpdate",
        value: { taskId: "task-1", statusChange: { to: "in_progress" } },
        updatedAt: "2026-07-24T00:00:01.000Z",
      }),
    ).toBe(true);
    expect(
      reduceClaudeTasks({
        state,
        toolUseId: "task-1",
        toolName: "task_updated",
        value: {
          task_id: "task-1",
          patch: { description: "Implement and verify reducer", status: "completed" },
        },
        updatedAt: "2026-07-24T00:00:02.000Z",
      }),
    ).toBe(true);

    expect(claudeTaskPlanPayload(state)).toEqual({
      plan: [{ step: "Implement and verify reducer", status: "completed" }],
    });
  });

  it("does not create plan entries from TaskGet identifiers alone", () => {
    const state = makeClaudeTaskState();

    expect(
      reduceClaudeTasks({
        state,
        toolUseId: "tool-get",
        toolName: "TaskGet",
        value: { task_id: "task-1" },
        updatedAt: "2026-07-24T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(claudeTaskPlanPayload(state)).toBeUndefined();
  });

  it("rejects a delayed patch after a newer task update", () => {
    const state = makeClaudeTaskState();

    reduceClaudeTasks({
      state,
      toolUseId: "task-1",
      toolName: "TaskCreate",
      value: { task_id: "task-1", subject: "Fresh task", status: "running" },
      updatedAt: "2026-07-24T00:00:02.000Z",
    });
    expect(
      reduceClaudeTasks({
        state,
        toolUseId: "task-1",
        toolName: "TaskUpdate",
        value: { task_id: "task-1", subject: "Stale task", status: "completed" },
        updatedAt: "2026-07-24T00:00:01.000Z",
      }),
    ).toBe(false);
    expect(state.tasks.get("task-1")).toMatchObject({
      subject: "Fresh task",
      status: "inProgress",
    });
  });

  it("rejects an older authoritative snapshot without removing newer tasks", () => {
    const state = makeClaudeTaskState();

    reduceClaudeTasks({
      state,
      toolUseId: "snapshot-new",
      toolName: "TaskList",
      authoritativeSnapshot: true,
      value: { tasks: [{ id: "task-1", subject: "Current", status: "running" }] },
      updatedAt: "2026-07-24T00:00:02.000Z",
    });
    expect(
      reduceClaudeTasks({
        state,
        toolUseId: "snapshot-old",
        toolName: "TaskList",
        authoritativeSnapshot: true,
        value: { tasks: [] },
        updatedAt: "2026-07-24T00:00:01.000Z",
      }),
    ).toBe(false);
    expect(state.tasks.has("task-1")).toBe(true);
  });
});
