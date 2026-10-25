import { RuntimeTaskId, ThreadId, type OrchestrationTask } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  demotePersistedTaskActivity,
  resolveRuntimeTaskIdentity,
  scopedProviderSubagentId,
} from "./ProviderRuntimeIngestion.tasks.identity.ts";
import { isDuplicateClaudeLifecycleUpsert } from "./ProviderRuntimeIngestion.tasks.map.ts";

const existingAgent: OrchestrationTask = {
  id: RuntimeTaskId.makeUnsafe("thread-a:7:child-1"),
  kind: "providerSubagent",
  nativeId: "child-1",
  activityFresh: true,
  status: "inProgress",
  subject: "Review implementation",
  source: "observed",
  freshness: { sessionEpoch: "7", sourcePriority: 1, observedOrdinal: 1 },
  createdAt: "2026-09-28T12:00:00.000Z",
  updatedAt: "2026-09-28T12:00:00.000Z",
};

describe("provider runtime task identity", () => {
  it("creates the exact globally scoped ID once at ingestion", () => {
    const id = scopedProviderSubagentId({
      threadId: ThreadId.makeUnsafe("thread-a"),
      sessionEpoch: 7,
      nativeId: "child-1",
    });

    expect(id).toBe("thread-a:7:child-1");
    expect(id).not.toContain("pi:thread-a:7:pi:");
  });

  it("prevents native child ID collisions across threads and sessions", () => {
    const ids = [
      scopedProviderSubagentId({
        threadId: ThreadId.makeUnsafe("thread-a"),
        sessionEpoch: 1,
        nativeId: "child-1",
      }),
      scopedProviderSubagentId({
        threadId: ThreadId.makeUnsafe("thread-a"),
        sessionEpoch: 2,
        nativeId: "child-1",
      }),
      scopedProviderSubagentId({
        threadId: ThreadId.makeUnsafe("thread-b"),
        sessionEpoch: 1,
        nativeId: "child-1",
      }),
    ];

    expect(new Set(ids).size).toBe(3);
  });

  it("demotes persisted running activity until the live runtime re-observes it", () => {
    expect(demotePersistedTaskActivity(existingAgent)).toMatchObject({
      status: "inProgress",
      activityFresh: false,
    });
  });

  it("does not borrow classification from the same native ID in an old session", () => {
    const identity = resolveRuntimeTaskIdentity({
      threadId: ThreadId.makeUnsafe("thread-a"),
      sessionEpoch: 8,
      incomingTaskId: RuntimeTaskId.makeUnsafe("child-1"),
      currentTasks: [existingAgent],
    });

    expect(identity).toMatchObject({
      id: "child-1",
      kind: "task",
      nativeId: "child-1",
    });
    expect(identity.previous).toBeUndefined();
  });

  it("preserves provider-subagent classification when a partial update omits kind", () => {
    const identity = resolveRuntimeTaskIdentity({
      threadId: ThreadId.makeUnsafe("thread-a"),
      sessionEpoch: 7,
      incomingTaskId: RuntimeTaskId.makeUnsafe("child-1"),
      currentTasks: [existingAgent],
    });

    expect(identity).toMatchObject({
      id: "thread-a:7:child-1",
      kind: "providerSubagent",
      nativeId: "child-1",
      previous: existingAgent,
    });
  });
});

describe("duplicate Claude lifecycle upserts", () => {
  const lifecycle = (provider: "claudeAgent" | "pi" | "copilot", type = "task.progress") =>
    ({ type, provider }) as Parameters<typeof isDuplicateClaudeLifecycleUpsert>[0];

  it("skips Claude lifecycle events for a task another source owns", () => {
    for (const type of ["task.started", "task.progress", "task.completed"]) {
      expect(isDuplicateClaudeLifecycleUpsert(lifecycle("claudeAgent", type), existingAgent)).toBe(
        true,
      );
    }
  });

  it("keeps Claude lifecycle events for new or lifecycle-owned tasks and task.updated", () => {
    expect(isDuplicateClaudeLifecycleUpsert(lifecycle("claudeAgent"), undefined)).toBe(false);
    expect(
      isDuplicateClaudeLifecycleUpsert(lifecycle("claudeAgent"), {
        ...existingAgent,
        source: "lifecycle",
      }),
    ).toBe(false);
    expect(
      isDuplicateClaudeLifecycleUpsert(lifecycle("claudeAgent", "task.updated"), existingAgent),
    ).toBe(false);
  });

  it("leaves every other provider's lifecycle upsert unchanged", () => {
    expect(isDuplicateClaudeLifecycleUpsert(lifecycle("pi"), existingAgent)).toBe(false);
    expect(isDuplicateClaudeLifecycleUpsert(lifecycle("copilot"), existingAgent)).toBe(false);
  });
});
