import type { ThreadSummary } from "@bigbud/contracts/orchestration/orchestration.catalog";
import { describe, expect, it } from "vitest";
import { applyOrchestrationEvent } from "../stores/main/events.store";
import {
  mapSequencedThreadSummary,
  mergeThreadSummary,
} from "../stores/main/helpers.lazy.summaries.store";
import { syncServerReadModel } from "../stores/main/helpers.snapshot.store";
import {
  makeState,
  makeReadModel,
  makeReadModelThread,
} from "../stores/main/main.store.test.helpers";
import { collectCompletedThreadCandidates } from "./taskCompletion.logic";
import { makeNotificationThread, notificationEvent, now } from "./taskCompletion.test.helpers";

function summary(sessionEpoch = 0): ThreadSummary {
  const thread = makeNotificationThread();
  return {
    ...thread,
    purpose: "standard",
    elevatorSummary: "Current task",
    pinnedAt: null,
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    sessionStatus: "ready",
    providerName: "codex",
    sessionEpoch,
    activeTurnId: null,
    latestTurnState: "completed",
    updatedAt: now,
    latestUserMessageAt: now,
    isWatching: false,
    isWatched: false,
    isDelegated: false,
    isAwaitingApproval: false,
  } as ThreadSummary;
}

function settlement(sequence: number, sessionEpoch = 0) {
  return {
    ...notificationEvent("thread.turn-settled", {
      threadId: "thread-1",
      turnId: "turn-1",
      outcome: "completed",
      sessionEpoch,
      completedAt: now,
    }),
    sequence,
  };
}

describe("native notification provenance", () => {
  it("accepts live proof after a newer terminal summary, once, without accepting replay", () => {
    const hydrated = mapSequencedThreadSummary(summary(), 10);
    const before = { ...hydrated, latestTurn: { ...hydrated.latestTurn! } };
    // Model running state before the newer catalog arrives; the initial baseline stays 10.
    delete before.latestTurn.terminalOutcome;
    const merged = mergeThreadSummary(before, summary(), 20);
    expect(collectCompletedThreadCandidates([before], [merged])).toEqual([]);
    const replay = applyOrchestrationEvent(makeState(merged), settlement(9)).threads[0]!;
    expect(collectCompletedThreadCandidates([merged], [replay])).toEqual([]);
    const live = applyOrchestrationEvent(makeState(merged), settlement(15)).threads[0]!;
    expect(collectCompletedThreadCandidates([merged], [live])).toHaveLength(1);
    const duplicate = applyOrchestrationEvent(makeState(live), settlement(15)).threads[0]!;
    expect(collectCompletedThreadCandidates([live], [duplicate])).toEqual([]);
    expect(duplicate.notificationObservation?.lastSettlementSequence).toBe(15);
  });

  it("does not give initial terminal hydration or full-snapshot replay live authority", () => {
    const hydrated = mapSequencedThreadSummary(summary(), 20);
    const replay = applyOrchestrationEvent(makeState(hydrated), settlement(20)).threads[0]!;
    expect(replay.notificationObservation?.settledTurnId).toBeUndefined();
    const model = {
      ...makeReadModel(makeReadModelThread({ latestTurn: hydrated.latestTurn })),
      snapshotSequence: 20,
    };
    const state = syncServerReadModel(makeState(hydrated), model);
    const next = applyOrchestrationEvent(state, settlement(19));
    expect(next.threads[0]?.notificationObservation?.settledTurnId).toBeUndefined();
  });

  it.each(["live", "catalog"])(
    "invalidates blocked old success when %s advances the session epoch",
    (source) => {
      const initial = makeNotificationThread();
      initial.notificationSafety = {
        ...initial.notificationSafety!,
        pendingRequestIds: ["approval"],
      };
      const bumped =
        source === "catalog"
          ? mergeThreadSummary(
              initial,
              { ...summary(1), notificationSafety: initial.notificationSafety },
              21,
            )
          : applyOrchestrationEvent(makeState(initial), {
              ...notificationEvent("thread.session-set", {
                threadId: initial.id,
                session: {
                  threadId: initial.id,
                  providerName: "codex",
                  status: "ready",
                  sessionEpoch: 1,
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: now,
                },
              }),
              sequence: 21,
            }).threads[0]!;
      const released = applyOrchestrationEvent(makeState(bumped), {
        ...notificationEvent("thread.activity-appended", {
          threadId: initial.id,
          activity: {
            id: "resolved",
            kind: "approval.resolved",
            tone: "info",
            summary: "Resolved",
            payload: { requestId: "approval" },
            turnId: null,
            createdAt: now,
          },
        }),
        sequence: 22,
      }).threads[0]!;
      expect(collectCompletedThreadCandidates([bumped], [released])).toEqual([]);
      expect(released.notificationObservation?.settledTurnId).toBeUndefined();
      const stale = applyOrchestrationEvent(makeState(released), settlement(23, 0)).threads[0]!;
      expect(collectCompletedThreadCandidates([released], [stale])).toEqual([]);
      const matching = applyOrchestrationEvent(makeState(released), settlement(24, 1)).threads[0]!;
      expect(collectCompletedThreadCandidates([released], [matching])).toHaveLength(1);
    },
  );
});
