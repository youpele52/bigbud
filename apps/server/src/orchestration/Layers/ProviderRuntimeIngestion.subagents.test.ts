import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asEventId,
  asThreadId,
  asTurnId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

type Harness = Awaited<ReturnType<typeof createHarness>>;

let ordinal = 0;
const agentUpdate = (payload: Record<string, unknown>, createdAt = new Date().toISOString()) => ({
  type: "task.updated" as const,
  eventId: asEventId(`evt-agent-${++ordinal}`),
  provider: "claudeAgent" as const,
  createdAt,
  threadId: asThreadId("thread-1"),
  payload: {
    taskId: "agent-1",
    kind: "providerSubagent",
    nativeId: "agent-1",
    activityFresh: true,
    status: "inProgress",
    subject: "Review implementation",
    source: "observed",
    freshness: { sessionEpoch: "0", sourcePriority: 2, observedOrdinal: ++ordinal },
    ...payload,
  },
});

const agentOf = async (harness: Harness) => {
  await harness.drain();
  const readModel = await Effect.runPromise(harness.engine.getReadModel());
  return readModel.threads
    .find((thread) => thread.id === "thread-1")
    ?.tasks?.find((task) => task.nativeId === "agent-1");
};

describe("ProviderRuntimeIngestion provider subagents", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it("persists display fields, keeps them across partial updates and stamps endedAt", async () => {
    const harness = await createHarness({ provider: "claudeAgent" });
    harness.emit(
      agentUpdate({
        model: "claude-sonnet-4-5",
        effort: "high",
        prompt: "Review the diff",
        depth: 1,
        metrics: { totalTokens: 100 },
        recentSteps: [{ id: "t1", toolName: "Read", status: "running", at: "2026-10-16T08:00Z" }],
      }),
    );
    await waitForThread(harness.engine, (thread) =>
      (thread.tasks ?? []).some((task) => task.model === "claude-sonnet-4-5"),
    );
    harness.emit(agentUpdate({ status: "completed", resultSummary: "No issues found" }));
    const agent = await waitForThread(harness.engine, (thread) =>
      (thread.tasks ?? []).some((task) => task.status === "completed"),
    ).then((thread) => thread.tasks?.[0]);

    expect(agent).toMatchObject({
      kind: "providerSubagent",
      model: "claude-sonnet-4-5",
      effort: "high",
      prompt: "Review the diff",
      depth: 1,
      metrics: { totalTokens: 100 },
      resultSummary: "No issues found",
    });
    expect(agent?.recentSteps).toHaveLength(1);
    expect(agent?.endedAt).toBeDefined();
  });

  it("reopens a terminal subagent for a newer run and clears its end time and result", async () => {
    const harness = await createHarness({ provider: "claudeAgent" });
    harness.emit(agentUpdate({ status: "completed", resultSummary: "First run" }));
    await waitForThread(harness.engine, (thread) =>
      (thread.tasks ?? []).some((task) => task.status === "completed"),
    );
    harness.emit(agentUpdate({ status: "inProgress" }));
    await waitForThread(harness.engine, (thread) =>
      (thread.tasks ?? []).some((task) => task.status === "inProgress"),
    );
    const agent = await agentOf(harness);
    expect(agent?.endedAt).toBeUndefined();
    expect(agent?.resultSummary).toBeUndefined();
  });

  it("throttles non-terminal progress and flushes it at the turn boundary", async () => {
    const harness = await createHarness({ provider: "claudeAgent" });
    harness.emit(agentUpdate({ progressSummary: "Starting" }));
    harness.emit(agentUpdate({ progressSummary: "Reading files" }));
    harness.emit(agentUpdate({ progressSummary: "Running tests" }));
    expect((await agentOf(harness))?.progressSummary).toBe("Starting");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });
    expect((await agentOf(harness))?.progressSummary).toBe("Running tests");
  });

  it("flushes elapsed pending progress before the thread's next runtime event", async () => {
    const harness = await createHarness({ provider: "claudeAgent" });
    harness.emit(agentUpdate({ progressSummary: "Starting" }));
    harness.emit(agentUpdate({ progressSummary: "Halfway" }));
    expect((await agentOf(harness))?.progressSummary).toBe("Starting");
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-unrelated"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      payload: { message: "unrelated" },
    });
    expect((await agentOf(harness))?.progressSummary).toBe("Halfway");
  });

  it("never throttles terminal states", async () => {
    const harness = await createHarness({ provider: "claudeAgent" });
    harness.emit(agentUpdate({ progressSummary: "Starting" }));
    harness.emit(agentUpdate({ progressSummary: "Pending" }));
    harness.emit(agentUpdate({ status: "failed", terminalReason: "boom" }));
    const agent = await agentOf(harness);
    expect(agent).toMatchObject({ status: "failed", terminalReason: "boom" });
    // The terminal snapshot was merged over the pending one, so nothing is lost.
    expect(agent?.progressSummary).toBe("Pending");
  });
});
