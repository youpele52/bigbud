import {
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { isThreadResidentWorkIdle, makeThreadResidency } from "./OrchestrationEngine.residency.ts";

const at = "2026-11-18T00:00:00.000Z";
const bounds = { maxResidentThreads: 3, idleTtlMs: 1_000, minResidencyMs: 100, batch: 10 };

function thread(id: string, overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: ProjectId.makeUnsafe("residency-project"),
    title: id,
    elevatorSummary: null,
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    queuedPrompts: [],
    pendingInterruptFlushIntent: null,
    pendingTurnControlOperation: null,
    queueHold: false,
    pendingTurnStart: null,
    recovery: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    tasks: [],
    activities: [],
    checkpoints: [],
    session: null,
    watchingThreads: [],
    ...overrides,
  } as OrchestrationThread;
}

describe("read-model residency", () => {
  it("keeps every thread that carries work a restart would resume", () => {
    const session = (status: "ready" | "running" | "stopped", activeTurnId: string | null = null) =>
      ({
        threadId: ThreadId.makeUnsafe("t"),
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: activeTurnId === null ? null : TurnId.makeUnsafe(activeTurnId),
        lastError: null,
        updatedAt: at,
      }) as OrchestrationThread["session"];
    expect(isThreadResidentWorkIdle(thread("idle"))).toBe(true);
    expect(isThreadResidentWorkIdle(thread("stopped", { session: session("stopped") }))).toBe(true);
    for (const busy of [
      thread("ready", { session: session("ready") }),
      thread("running", { session: session("running", "turn") }),
      thread("pinned", { pinnedAt: at }),
      thread("deleting", { deletingAt: at }),
      thread("pending", {
        pendingTurnStart: { messageId: MessageId.makeUnsafe("m"), requestedAt: at },
      }),
      thread("queued", { queuedPrompts: [{ id: "q" }] as never }),
      thread("recovery", { recovery: {} as never }),
      thread("control", { pendingTurnControlOperation: {} as never }),
      thread("flush", { pendingInterruptFlushIntent: {} as never }),
      thread("task", { tasks: [{ status: "inProgress" }] as never }),
      thread("watch", { watchingThreads: [{}] as never }),
    ]) {
      expect(isThreadResidentWorkIdle(busy), busy.id).toBe(false);
    }
  });

  it("selects idle threads past the TTL, least recently used first", () => {
    let now = 0;
    const residency = makeThreadResidency(bounds, () => now);
    const threads = [thread("a"), thread("b")];
    residency.selectCandidates(threads); // first seen at 0
    now = 500;
    residency.touch(ThreadId.makeUnsafe("b"));
    now = 1_200;
    expect(residency.selectCandidates(threads)).toEqual(["a"]);
    now = 1_600;
    expect(residency.selectCandidates(threads)).toEqual(["a", "b"]);
  });

  it("trims to the bound past the minimum residency, never a recently touched thread", () => {
    let now = 0;
    const residency = makeThreadResidency(bounds, () => now);
    const threads = ["a", "b", "c", "d", "e"].map((id) => thread(id));
    residency.selectCandidates(threads);
    now = 50;
    expect(residency.selectCandidates(threads)).toEqual([]);
    now = 200;
    residency.touch(ThreadId.makeUnsafe("a"));
    // Five resident against a bound of three: the two least recently used go.
    expect(residency.selectCandidates(threads)).toEqual(["b", "c"]);
  });

  it("never selects a parent of a resident thread or a busy thread, and caps the batch", () => {
    let now = 0;
    const residency = makeThreadResidency({ ...bounds, batch: 1 }, () => now);
    const parent = thread("parent");
    const child = thread("child", {
      parentThread: { threadId: parent.id, title: "parent", projectId: parent.projectId },
    });
    const pinned = thread("pinned", { pinnedAt: at });
    residency.selectCandidates([parent, child, pinned]);
    now = 5_000;
    expect(residency.selectCandidates([parent, child, pinned])).toEqual(["child"]);
    expect(residency.selectCandidates([parent, pinned])).toEqual(["parent"]);
  });
});
