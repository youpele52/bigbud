import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { TaskUpdatedPayload } from "./providerRuntime.payloads.tasks";

const decode = Schema.decodeUnknownSync(TaskUpdatedPayload);

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
});
