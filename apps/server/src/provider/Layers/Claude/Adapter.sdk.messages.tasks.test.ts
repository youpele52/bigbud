import { describe, expect, it } from "vitest";

import {
  decodeClaudeBackgroundTasksChangedMessage,
  decodeClaudeTaskNotificationMessage,
  decodeClaudeTaskProgressMessage,
  decodeClaudeTaskStartedMessage,
  decodeClaudeTaskUpdatedMessage,
} from "./Adapter.sdk.messages.ts";

const base = { type: "system", session_id: "session-1" } as const;

describe("Claude task update decoding", () => {
  it.each(["in_progress", "complete", "done"])("accepts %s status aliases", (status) => {
    expect(
      decodeClaudeTaskUpdatedMessage({
        type: "system",
        subtype: "task_updated",
        uuid: `task-update-${status}`,
        session_id: "session-1",
        task_id: "task-1",
        patch: { status },
      }),
    ).toMatchObject({ taskId: "task-1", patch: { status } });
  });

  it("rejects unknown task statuses", () => {
    expect(
      decodeClaudeTaskUpdatedMessage({
        type: "system",
        subtype: "task_updated",
        uuid: "task-update-invalid",
        session_id: "session-1",
        task_id: "task-1",
        patch: { status: "finished" },
      }),
    ).toBeUndefined();
  });
});

describe("Claude SDK 0.3.301 task field decoding", () => {
  it("decodes every subagent field of task_started with bounded strings", () => {
    expect(
      decodeClaudeTaskStartedMessage({
        ...base,
        subtype: "task_started",
        uuid: "started-1",
        task_id: "task-1",
        run_id: "run-1",
        tool_use_id: "toolu-1",
        description: "Review diff",
        subagent_type: "code-reviewer",
        is_backgrounded: true,
        spawn_depth: 2,
        parent_task_id: "task-0",
        task_type: "local_agent",
        workflow_name: "spec",
        prompt: "p".repeat(5_000),
        skip_transcript: false,
        ambient: false,
      }),
    ).toMatchObject({
      taskId: "task-1",
      runId: "run-1",
      toolUseId: "toolu-1",
      subagentType: "code-reviewer",
      isBackgrounded: true,
      spawnDepth: 2,
      parentTaskId: "task-0",
      taskType: "local_agent",
      workflowName: "spec",
      ambient: false,
      prompt: expect.stringMatching(/^p{999}…$/u),
    });
  });

  it("decodes run, type, reason and ambient fields on the other task messages", () => {
    expect(
      decodeClaudeBackgroundTasksChangedMessage({
        ...base,
        subtype: "background_tasks_changed",
        uuid: "bg-1",
        tasks: [
          {
            task_id: "task-1",
            run_id: "run-1",
            task_type: "local_agent",
            subagent_type: "Explore",
            description: "Index docs",
            parent_task_id: "task-0",
            ambient: true,
          },
        ],
      })?.tasks[0],
    ).toEqual({
      taskId: "task-1",
      runId: "run-1",
      taskType: "local_agent",
      subagentType: "Explore",
      description: "Index docs",
      parentTaskId: "task-0",
      ambient: true,
    });
    expect(
      decodeClaudeTaskNotificationMessage({
        ...base,
        subtype: "task_notification",
        uuid: "note-1",
        task_id: "task-1",
        run_id: "run-1",
        status: "stopped",
        reason: "worker_restart",
        ambient: false,
        output_file: "/tmp/out",
        summary: "Stopped",
      }),
    ).toMatchObject({ runId: "run-1", reason: "worker_restart", ambient: false });
    expect(
      decodeClaudeTaskProgressMessage({
        ...base,
        subtype: "task_progress",
        uuid: "progress-1",
        task_id: "task-1",
        run_id: "run-1",
        description: "Review",
        subagent_type: "code-reviewer",
        usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
      }),
    ).toMatchObject({ runId: "run-1", subagentType: "code-reviewer" });
  });

  it("tolerates absent optional fields and ignores mistyped ones", () => {
    const started = decodeClaudeTaskStartedMessage({
      ...base,
      subtype: "task_started",
      uuid: "started-2",
      task_id: "task-2",
      description: "Run",
      spawn_depth: -1,
      is_backgrounded: "yes",
    });
    expect(started).toBeDefined();
    expect(started?.spawnDepth).toBeUndefined();
    expect(started?.isBackgrounded).toBeUndefined();
    expect(started?.taskType).toBeUndefined();
  });
});
