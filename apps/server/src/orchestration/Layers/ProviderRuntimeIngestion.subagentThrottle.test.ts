import { RuntimeTaskId, type OrchestrationTask } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { SubagentUpsertThrottle } from "./ProviderRuntimeIngestion.subagentThrottle.ts";

const agent = (overrides: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id: RuntimeTaskId.makeUnsafe("thread-1:1:agent-1"),
  kind: "providerSubagent",
  nativeId: "agent-1",
  activityFresh: true,
  status: "inProgress",
  subject: "Review",
  source: "observed",
  freshness: { sessionEpoch: "1", sourcePriority: 2, observedOrdinal: 1 },
  createdAt: "2026-10-16T08:00:00.000Z",
  updatedAt: "2026-10-16T08:00:00.000Z",
  ...overrides,
});

describe("SubagentUpsertThrottle", () => {
  it("never throttles ordinary tasks, first updates, status/model changes or terminal states", () => {
    const throttle = new SubagentUpsertThrottle();
    const ordinary = agent({ kind: "task" });
    expect(
      throttle.decide({ threadId: "t", task: ordinary, previous: ordinary, nowMs: 0 }),
    ).toEqual({ persist: true, evicted: [] });
    const first = agent();
    expect(
      throttle.decide({ threadId: "t", task: first, previous: undefined, nowMs: 0 }).persist,
    ).toBe(true);
    const modelChange = agent({ model: "opus" });
    expect(
      throttle.decide({ threadId: "t", task: modelChange, previous: first, nowMs: 10 }).persist,
    ).toBe(true);
    const stopped = agent({ status: "stopped", model: "opus" });
    expect(
      throttle.decide({ threadId: "t", task: stopped, previous: modelChange, nowMs: 20 }).persist,
    ).toBe(true);
    const completed = agent({ status: "completed", model: "opus" });
    expect(
      throttle.decide({ threadId: "t", task: completed, previous: completed, nowMs: 30 }).persist,
    ).toBe(true);
  });

  it("persists non-terminal progress at most once per window and keeps the latest pending", () => {
    const throttle = new SubagentUpsertThrottle({ windowMs: 1_000 });
    const first = agent();
    throttle.decide({ threadId: "t", task: first, previous: undefined, nowMs: 0 });
    const second = agent({ progressSummary: "Reading files" });
    expect(
      throttle.decide({ threadId: "t", task: second, previous: first, nowMs: 200 }).persist,
    ).toBe(false);
    const third = agent({ progressSummary: "Running tests" });
    expect(
      throttle.decide({ threadId: "t", task: third, previous: first, nowMs: 400 }).persist,
    ).toBe(false);
    expect(throttle.pending("t", first.id)).toBe(third);
    expect(throttle.takeDue("t", 999)).toEqual([]);
    expect(throttle.takeDue("t", 1_000)).toEqual([third]);
    expect(throttle.pending("t", first.id)).toBeUndefined();
    // The flush counts as a persisted write and opens a new window.
    const fourth = agent({ progressSummary: "Summarising" });
    expect(
      throttle.decide({ threadId: "t", task: fourth, previous: third, nowMs: 1_500 }).persist,
    ).toBe(false);
    expect(
      throttle.decide({ threadId: "t", task: fourth, previous: third, nowMs: 2_000 }).persist,
    ).toBe(true);
  });

  it("flushes every pending entry for a thread at a boundary and drops terminal tracking", () => {
    const throttle = new SubagentUpsertThrottle();
    const one = agent();
    const two = agent({ id: RuntimeTaskId.makeUnsafe("thread-1:1:agent-2"), nativeId: "agent-2" });
    throttle.decide({ threadId: "t", task: one, previous: undefined, nowMs: 0 });
    throttle.decide({ threadId: "t", task: two, previous: undefined, nowMs: 0 });
    throttle.decide({
      threadId: "t",
      task: agent({ progressSummary: "a" }),
      previous: one,
      nowMs: 5,
    });
    throttle.decide({
      threadId: "t",
      task: { ...two, progressSummary: "b" },
      previous: two,
      nowMs: 5,
    });
    throttle.decide({
      threadId: "u",
      task: agent({ progressSummary: "c" }),
      previous: undefined,
      nowMs: 5,
    });
    expect(throttle.takeAll("t").map((task) => task.progressSummary)).toEqual(["a", "b"]);
    expect(throttle.takeAll("t")).toEqual([]);
    expect(throttle.takeEverything()).toEqual([]);
  });

  it("discards pending entries for removed tasks", () => {
    const throttle = new SubagentUpsertThrottle();
    const first = agent();
    throttle.decide({ threadId: "t", task: first, previous: undefined, nowMs: 0 });
    throttle.decide({
      threadId: "t",
      task: agent({ progressSummary: "x" }),
      previous: first,
      nowMs: 1,
    });
    throttle.discard("t", first.id);
    expect(throttle.takeAll("t")).toEqual([]);
  });

  it("evicts least-recently-used tasks and threads, returning their pending updates", () => {
    const throttle = new SubagentUpsertThrottle({ maxTasksPerThread: 2, maxThreads: 2 });
    const task = (index: number, summary?: string) =>
      agent({
        id: RuntimeTaskId.makeUnsafe(`agent-${index}`),
        nativeId: `agent-${index}`,
        ...(summary ? { progressSummary: summary } : {}),
      });
    throttle.decide({ threadId: "t", task: task(1), previous: undefined, nowMs: 0 });
    throttle.decide({ threadId: "t", task: task(1, "pending-1"), previous: task(1), nowMs: 1 });
    throttle.decide({ threadId: "t", task: task(2), previous: undefined, nowMs: 2 });
    const evictTask = throttle.decide({
      threadId: "t",
      task: task(3),
      previous: undefined,
      nowMs: 3,
    });
    expect(evictTask.evicted).toEqual([{ threadId: "t", task: task(1, "pending-1") }]);

    throttle.decide({ threadId: "t", task: task(2, "pending-2"), previous: task(2), nowMs: 4 });
    throttle.decide({ threadId: "u", task: task(9), previous: undefined, nowMs: 5 });
    const evictThread = throttle.decide({
      threadId: "v",
      task: task(8),
      previous: undefined,
      nowMs: 6,
    });
    expect(evictThread.evicted).toEqual([{ threadId: "t", task: task(2, "pending-2") }]);
    expect(throttle.takeAll("t")).toEqual([]);
  });
});
