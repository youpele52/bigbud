import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationTask } from "./orchestration.thread.tasks";
import { TaskUpdatedPayload } from "./providerRuntime.payloads.tasks";

const decode = Schema.decodeUnknownSync(TaskUpdatedPayload);
const decodeTask = Schema.decodeUnknownSync(OrchestrationTask);

const step = (index: number) => ({
  id: `tool-${index}`,
  toolName: "Read",
  label: `Read file ${index}`,
  status: "completed",
  at: "2026-10-16T08:00:00.000Z",
});

describe("TaskUpdatedPayload", () => {
  it("keeps legacy and ambiguous task updates out of the Agents view", () => {
    const task = decode({
      taskId: "task-1",
      status: "pending",
      subject: "Ordinary task",
      source: "taskList",
      freshness: { sessionEpoch: "legacy", sourcePriority: 1, observedOrdinal: 1 },
    });

    expect(task.kind ?? "task").toBe("task");
    expect(task.activityFresh ?? false).toBe(false);
  });

  it("decodes explicit provider subagent identity and fresh activity evidence", () => {
    const task = decode({
      taskId: "thread:epoch:native-agent",
      kind: "providerSubagent",
      nativeId: "native-agent",
      activityFresh: true,
      status: "inProgress",
      subject: "Review implementation",
      source: "observed",
      freshness: { sessionEpoch: "epoch", sourcePriority: 1, observedOrdinal: 2 },
    });

    expect(task).toMatchObject({
      kind: "providerSubagent",
      nativeId: "native-agent",
      activityFresh: true,
    });
  });

  it("decodes the additive provider subagent display fields", () => {
    const task = decode({
      taskId: "thread:epoch:agent",
      kind: "providerSubagent",
      status: "completed",
      subject: "Review implementation",
      model: "claude-sonnet-4-5",
      effort: "high",
      prompt: "Review the diff",
      depth: 2,
      endedAt: "2026-10-16T08:01:00.000Z",
      resultSummary: "No issues found",
      metrics: { totalTokens: 1200, toolUses: 3, durationMs: 4500, costUsd: 0.02 },
      recentSteps: [step(1), { toolName: "Bash", status: "running", at: "2026-10-16T08:00:01Z" }],
      source: "observed",
      freshness: { sessionEpoch: "epoch", sourcePriority: 1, observedOrdinal: 3 },
    });

    expect(task).toMatchObject({
      model: "claude-sonnet-4-5",
      effort: "high",
      prompt: "Review the diff",
      depth: 2,
      endedAt: "2026-10-16T08:01:00.000Z",
      resultSummary: "No issues found",
      metrics: { totalTokens: 1200, toolUses: 3, durationMs: 4500, costUsd: 0.02 },
    });
    expect(task.recentSteps).toHaveLength(2);
  });

  it("rejects more than five recent steps and negative metrics", () => {
    const base = {
      taskId: "thread:epoch:agent",
      status: "inProgress",
      subject: "Agent",
      source: "observed",
      freshness: { sessionEpoch: "epoch", sourcePriority: 1, observedOrdinal: 1 },
    };
    expect(() =>
      decode({ ...base, recentSteps: [1, 2, 3, 4, 5, 6].map((index) => step(index)) }),
    ).toThrow();
    expect(() => decode({ ...base, metrics: { costUsd: -1 } })).toThrow();
    expect(() => decode({ ...base, metrics: { totalTokens: 1.5 } })).toThrow();
  });
});

describe("OrchestrationTask", () => {
  it("hydrates a legacy task_json row without subagent display fields", () => {
    const task = decodeTask({
      id: "task-legacy",
      status: "inProgress",
      subject: "Legacy row",
      usage: { total_tokens: 10 },
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });

    expect(task.source).toBe("lifecycle");
    expect(task.freshness.sessionEpoch).toBe("legacy");
    expect(task.model).toBeUndefined();
    expect(task.recentSteps).toBeUndefined();
    expect(task.metrics).toBeUndefined();
  });

  it("round-trips the subagent display fields on a durable task", () => {
    const task = decodeTask({
      id: "task-agent",
      kind: "providerSubagent",
      status: "completed",
      subject: "Agent",
      model: "gpt-5",
      depth: 1,
      endedAt: "2026-10-16T08:01:00.000Z",
      recentSteps: [step(1)],
      metrics: { toolUses: 1 },
      createdAt: "2026-10-16T08:00:00.000Z",
      updatedAt: "2026-10-16T08:01:00.000Z",
    });

    expect(task).toMatchObject({ model: "gpt-5", depth: 1, metrics: { toolUses: 1 } });
    expect(task.recentSteps?.[0]?.id).toBe("tool-1");
  });
});
