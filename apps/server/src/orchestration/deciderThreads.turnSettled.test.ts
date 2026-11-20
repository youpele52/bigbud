import {
  CommandId,
  CheckpointRef,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decideThreadTurnSettle } from "./deciderThreads.turnSettled.ts";
import { projectThreadTurnSettled } from "./projectorThreadTurnSettled.ts";
import { projectThreadReverted } from "./projectorThreadReverted.ts";
import { makeEvent } from "./projector.test.helpers.ts";

const now = "2026-11-11T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("thread-settlement");
const turnId = TurnId.makeUnsafe("turn-settlement");
function model(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project"),
        title: "Settlement",
        elevatorSummary: null,
        elevatorSummaryMessageCount: 0,
        modelSelection: { provider: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        pinnedAt: null,
        deletingAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        tasks: [],
        activities: [],
        checkpoints: [],
        watchingThreads: [],
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          reason: null,
          lastError: null,
          sessionEpoch: 2,
          updatedAt: now,
        },
      },
    ],
  };
}
function command() {
  return {
    type: "thread.turn.settle" as const,
    commandId: CommandId.makeUnsafe("settle"),
    threadId,
    turnId,
    sessionEpoch: 2,
    outcome: "completed" as const,
    createdAt: now,
    completedAt: now,
  };
}
function settledEvent(outcome: "completed" | "failed" | "interrupted" | "cancelled") {
  return makeEvent({
    sequence: 1,
    type: "thread.turn-settled",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: "settle",
    payload: { ...command(), outcome },
  }) as Extract<OrchestrationEvent, { type: "thread.turn-settled" }>;
}

describe("authoritative turn settlement", () => {
  it("accepts matching native proof and rejects stale epoch, wrong turn and repetition", async () => {
    const readModel = model();
    expect(
      await Effect.runPromise(decideThreadTurnSettle({ command: command(), readModel })),
    ).toMatchObject({
      type: "thread.turn-settled",
      payload: { outcome: "completed", sessionEpoch: 2 },
    });
    for (const patch of [{ sessionEpoch: 1 }, { turnId: TurnId.makeUnsafe("old") }]) {
      expect(
        await Effect.runPromise(
          decideThreadTurnSettle({ command: { ...command(), ...patch }, readModel }),
        ),
      ).toEqual([]);
    }
    const completed = projectThreadTurnSettled(readModel, settledEvent("completed"));
    expect(
      await Effect.runPromise(decideThreadTurnSettle({ command: command(), readModel: completed })),
    ).toEqual([]);
  });

  it.each([
    ["completed", "completed"],
    ["failed", "error"],
    ["interrupted", "interrupted"],
    ["cancelled", "interrupted"],
  ] as const)("projects %s durably without conflating failures with success", (outcome, state) => {
    const projected = projectThreadTurnSettled(model(), settledEvent(outcome));
    expect(projected.threads[0]?.latestTurn).toMatchObject({
      terminalOutcome: outcome,
      state,
      completedAt: now,
    });
    expect(projectThreadTurnSettled(projected, settledEvent("completed")).threads[0]).toEqual(
      projected.threads[0],
    );
  });

  it("preserves same-run native proof on revert without manufacturing historical proof", async () => {
    const settled = projectThreadTurnSettled(model(), settledEvent("completed"));
    const thread = settled.threads[0]!;
    const checkpoint = {
      turnId,
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.makeUnsafe("refs/checkpoint/1"),
      status: "ready" as const,
      files: [],
      assistantMessageId: null,
      completedAt: now,
    };
    const event = makeEvent({
      sequence: 2,
      type: "thread.reverted",
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: now,
      commandId: "revert",
      payload: { threadId, turnCount: 1 },
    }) as Extract<OrchestrationEvent, { type: "thread.reverted" }>;
    const retained = await Effect.runPromise(
      projectThreadReverted(
        { ...settled, threads: [{ ...thread, checkpoints: [checkpoint] }] },
        event,
      ),
    );
    expect(retained.threads[0]?.latestTurn).toEqual(thread.latestTurn);
    const historical = await Effect.runPromise(
      projectThreadReverted(
        {
          ...settled,
          threads: [
            { ...thread, checkpoints: [{ ...checkpoint, turnId: TurnId.makeUnsafe("earlier") }] },
          ],
        },
        event,
      ),
    );
    expect(historical.threads[0]?.latestTurn?.turnId).toBe("earlier");
    expect(historical.threads[0]?.latestTurn?.terminalOutcome).toBeUndefined();
  });

  it("does not graft stale proof onto a different run or epoch", () => {
    const readModel = model();
    const event = settledEvent("completed");
    expect(
      projectThreadTurnSettled(readModel, {
        ...event,
        payload: { ...event.payload, turnId: TurnId.makeUnsafe("old") },
      }).threads[0],
    ).toEqual(readModel.threads[0]);
    expect(
      projectThreadTurnSettled(readModel, {
        ...event,
        payload: { ...event.payload, sessionEpoch: 1 },
      }).threads[0],
    ).toEqual(readModel.threads[0]);
  });
});
