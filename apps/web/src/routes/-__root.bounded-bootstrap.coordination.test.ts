import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runBoundedBootstrap } from "./-__root.bounded-bootstrap";
import { createEventRouterRecovery } from "./-__root.recovery";
import { recoverAndAcknowledgeDeliveryBaseline } from "./-__root.delivery-routing";
import { recordWsConnectionAttempt } from "../rpc/wsConnectionState";
import { useStore } from "../stores/main";
import { threadHydrationEventBuffer } from "../logic/orchestration/thread-hydration-events.logic";
import {
  createProjectGateApi,
  resetProjectGateStore,
  recentId,
  otherId,
} from "../components/chat/view/ThreadProjectGate.test-helpers";

vi.mock("./-__root.ownership-reconciliation", () => ({
  reconcileAppliedCanonicalOwnership: vi.fn(async () => undefined),
}));

beforeEach(resetProjectGateStore);
afterEach(() => {
  vi.useRealTimers();
  threadHydrationEventBuffer.clear();
});

function blockCatalog() {
  const fixture = createProjectGateApi();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = fixture.orchestration.getStartupProjectCatalog.getMockImplementation()!;
  fixture.orchestration.getStartupProjectCatalog.mockImplementation(async (input) => {
    await pending;
    return read(input);
  });
  return { ...fixture, release };
}

it.each([null, recentId, otherId])(
  "preserves independent bootstrap completions when the second selection is %s",
  async (selectedThreadId) => {
    const fixture = blockCatalog();
    const first = runBoundedBootstrap({
      api: fixture.api,
      selectedThreadId: recentId,
      disposed: () => false,
    });
    // Attach both handlers before releasing either RPC, including on the broken implementation.
    const second = runBoundedBootstrap({
      api: fixture.api,
      selectedThreadId,
      disposed: () => false,
    });
    const results = Promise.allSettled([first, second]);
    fixture.release();
    expect(await results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 10 },
    ]);
    if (selectedThreadId !== null) {
      expect(useStore.getState().threadHydrationById[selectedThreadId]?.status).toBe("complete");
    }
  },
);

it("does not lose the EventRouter baseline completion to compact restoration in the same renderer", async () => {
  const fixture = blockCatalog();
  const recovery = createEventRouterRecovery({
    api: fixture.api,
    queryClient: new QueryClient(),
    clearAllThinkingDeltas: vi.fn(),
    reconcileThinkingActivities: vi.fn(),
    applyOrchestrationEvents: (events) => useStore.getState().applyOrchestrationEvents(events),
    syncProjects: vi.fn(),
    syncThreads: vi.fn(),
    clearThreadUi: vi.fn(),
    removeFromSelection: vi.fn(),
    removeTerminalState: vi.fn(),
    removeOrphanedTerminalStates: vi.fn(),
    applyTerminalEvent: vi.fn(),
  });
  try {
    const acknowledge = vi.fn(async () => ({
      accepted: true,
      fenced: false,
      acknowledgedSequence: 10,
    }));
    const baseline = recoverAndAcknowledgeDeliveryBaseline({
      recovery: {
        type: "recovery",
        route: "direct-unmanaged",
        recoveryId: "baseline-1",
        consumerId: "compact-1",
        consumerGeneration: 1,
        serverEpoch: "same-db",
        acknowledgedSequence: 0,
        targetSequence: 10,
        reasonCode: "replay_budget_exceeded",
      },
      recover: () => recovery.runDeliveryBaselineRecovery(null, () => false, "same-db"),
      acknowledge,
    }).then((result) => result.acknowledgedSequence);
    await vi.waitFor(() =>
      expect(fixture.orchestration.getSidebarThreadCatalog).toHaveBeenCalled(),
    );
    const restore = runBoundedBootstrap({
      api: fixture.api,
      selectedThreadId: recentId,
      disposed: () => false,
    });
    const results = Promise.allSettled([baseline, restore]);
    fixture.release();
    expect(await results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 10 },
    ]);
    expect(recovery.getAppliedSequence()).toBe(10);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        recoveryId: "baseline-1",
        appliedProjectionSequence: 10,
        serverEpoch: "same-db",
      }),
    );
  } finally {
    recovery.cancel();
  }
});

it("expires a queued caller without stealing the active hydration token or starting reads", async () => {
  vi.useFakeTimers();
  const active = blockCatalog();
  const waiting = createProjectGateApi();
  const first = runBoundedBootstrap({
    api: active.api,
    selectedThreadId: recentId,
    disposed: () => false,
    timeoutMs: 100,
  });
  const second = runBoundedBootstrap({
    api: waiting.api,
    selectedThreadId: recentId,
    disposed: () => false,
    timeoutMs: 10,
  });
  const rejected = expect(second).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(11);
  await rejected;
  expect(waiting.orchestration.getSelectedThreadDetail).not.toHaveBeenCalled();
  expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("loading");
  active.release();
  await expect(first).resolves.toBe(10);
  expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("complete");
});

it.each(["epoch", "connection", "disposed"] as const)(
  "fences a queued caller after its %s intent is revoked, without issuing its RPCs",
  async (reason) => {
    const active = blockCatalog();
    const waiting = createProjectGateApi();
    const first = runBoundedBootstrap({
      api: active.api,
      selectedThreadId: null,
      disposed: () => false,
    });
    let disposed = false;
    const second = runBoundedBootstrap({
      api: waiting.api,
      selectedThreadId: recentId,
      disposed: () => disposed,
    });
    const results = Promise.allSettled([first, second]);
    if (reason === "epoch") useStore.getState().resetProjectCatalogEpoch("new-db");
    else if (reason === "connection") recordWsConnectionAttempt("ws://localhost:3773/ws");
    else disposed = true;
    active.release();
    const settled = await results;
    expect(settled[0]?.status).toBe(reason === "disposed" ? "fulfilled" : "rejected");
    expect(settled[1]).toMatchObject({
      status: "rejected",
      reason: new Error("Thread loading was superseded. Retry loading."),
    });
    expect(waiting.orchestration.getSidebarThreadCatalog).not.toHaveBeenCalled();
    expect(waiting.orchestration.getSelectedThreadDetail).not.toHaveBeenCalled();
    expect(useStore.getState().threadHydrationById[recentId]?.status).not.toBe("loading");
  },
);

it("releases a timed-out authority even when its RPC never settles", async () => {
  vi.useFakeTimers();
  const active = blockCatalog();
  const waiting = createProjectGateApi();
  const first = runBoundedBootstrap({
    api: active.api,
    selectedThreadId: recentId,
    disposed: () => false,
    timeoutMs: 10,
  });
  const rejected = expect(first).rejects.toThrow("timed out");
  const second = runBoundedBootstrap({
    api: waiting.api,
    selectedThreadId: otherId,
    disposed: () => false,
    timeoutMs: 100,
  });
  await vi.advanceTimersByTimeAsync(11);
  await rejected;
  await expect(second).resolves.toBe(10);
  expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("failed");
  expect(useStore.getState().threadHydrationById[otherId]?.status).toBe("complete");
  const projects = useStore.getState().projects;
  active.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(useStore.getState().projects).toBe(projects);
});
