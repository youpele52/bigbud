import { describe, expect, it } from "vitest";
import { applyOrchestrationEvent } from "../stores/main/events.store";
import { makeState } from "../stores/main/main.store.test.helpers";
import { hasUnsettledCurrentRunWork } from "../logic/thread/threadBackgroundWork.logic";
import { collectCompletedThreadCandidates } from "./taskCompletion.logic";
import { makeNotificationThread, notificationEvent, now } from "./taskCompletion.test.helpers";

const selected = { id: "selected", turnId: "turn-1" as never, updatedAt: now, implementedAt: null };
function planEvent(
  id: string,
  turnId: string,
  implementedAt: string | null,
  updatedAt = "2026-11-11T11:00:00.000Z",
) {
  return notificationEvent("thread.proposed-plan-upserted", {
    threadId: "thread-1",
    proposedPlan: {
      id,
      turnId,
      implementedAt,
      updatedAt,
      createdAt: now,
      planMarkdown: "Plan",
      implementationThreadId: null,
    },
  });
}

describe("selected actionable plan safety", () => {
  it.each([true, false])(
    "clears only the matching selected implementation (summary-only: %s)",
    (summaryOnly) => {
      const thread = makeNotificationThread({ interactionMode: "plan" });
      thread.notificationSafety = {
        ...thread.notificationSafety!,
        hasActionablePlan: true,
        selectedPlan: selected,
      };
      if (!summaryOnly)
        thread.proposedPlans = [
          {
            ...selected,
            createdAt: now,
            planMarkdown: "Plan",
            implementationThreadId: null,
          } as never,
        ];
      const unrelated = applyOrchestrationEvent(
        makeState(thread),
        planEvent("other", "older", now),
      );
      expect(hasUnsettledCurrentRunWork(unrelated.threads[0]!)).toBe(true);
      const implemented = applyOrchestrationEvent(unrelated, planEvent("selected", "turn-1", now));
      expect(implemented.threads[0]?.notificationSafety?.hasActionablePlan).toBe(false);
      expect(hasUnsettledCurrentRunWork(implemented.threads[0]!)).toBe(false);
      expect(collectCompletedThreadCandidates(unrelated.threads, implemented.threads)).toHaveLength(
        1,
      );
      const replay = applyOrchestrationEvent(
        implemented,
        planEvent("selected", "turn-1", null, now),
      );
      expect(replay.threads[0]?.notificationSafety?.hasActionablePlan).toBe(false);
      expect(hasUnsettledCurrentRunWork(replay.threads[0]!)).toBe(false);
    },
  );

  it("still notifies after stale plan replay when the final independent blocker resolves", () => {
    const thread = makeNotificationThread({ interactionMode: "plan" });
    thread.notificationSafety = {
      ...thread.notificationSafety!,
      hasActionablePlan: true,
      selectedPlan: selected,
      pendingRequestIds: ["approval"],
    };
    const implemented = applyOrchestrationEvent(
      makeState(thread),
      planEvent("selected", "turn-1", now),
    );
    const replay = applyOrchestrationEvent(implemented, planEvent("selected", "turn-1", null, now));
    const released = applyOrchestrationEvent(
      replay,
      notificationEvent("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          id: "resolved",
          kind: "approval.resolved",
          tone: "info",
          summary: "Resolved",
          turnId: null,
          createdAt: now,
          payload: { requestId: "approval" },
        },
      }),
    );
    expect(collectCompletedThreadCandidates(replay.threads, released.threads)).toHaveLength(1);
  });

  it("selects the new run's implemented plan instead of retaining an old actionable latch", () => {
    const thread = makeNotificationThread({ interactionMode: "plan" });
    thread.notificationSafety = {
      ...thread.notificationSafety!,
      hasActionablePlan: true,
      selectedPlan: selected,
    };
    // A plan for the next run can already be loaded before the session switches turns.
    const plan = planEvent("new", "new-turn", now);
    const before = applyOrchestrationEvent(makeState(thread), plan);
    const next = applyOrchestrationEvent(
      before,
      notificationEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          providerName: "codex",
          status: "running",
          sessionEpoch: 0,
          activeTurnId: "new-turn",
          lastError: null,
          updatedAt: now,
        },
      }),
    );
    expect(next.threads[0]?.latestTurn?.turnId).toBe("new-turn");
    expect(next.threads[0]?.notificationSafety?.selectedPlan?.id).toBe("new");
    expect(next.threads[0]?.notificationSafety?.hasActionablePlan).toBe(false);
  });
});
