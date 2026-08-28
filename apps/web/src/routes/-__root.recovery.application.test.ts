import { CommandId, ThreadId, type NativeApi, type OrchestrationEvent } from "@bigbud/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchCommandWithOutcomeRecovery,
  readPendingCommands,
} from "../lib/orchestrationCommandRecovery";
import { makeEvent } from "../stores/main/main.store.test.helpers";
import { reconcileAppliedCanonicalOwnership } from "./-__root.ownership-reconciliation";
import { createEventRouterRecovery } from "./-__root.recovery";

vi.mock("./-__root.ownership-reconciliation", () => ({
  reconcileAppliedCanonicalOwnership: vi.fn(async () => undefined),
}));

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve: () => resolve?.() };
}

function makeApi() {
  const replayEvents = vi.fn(async (fromSequenceExclusive: number) => ({
    requestedFromSequenceExclusive: fromSequenceExclusive,
    retainedFromSequenceExclusive: 0,
    earliestAvailableSequence: 1,
    latestSequence: 11,
    availability: "available" as const,
    complete: true,
    events: [],
  }));
  return {
    api: {
      orchestration: {
        getSidebarThreadCatalog: vi.fn(async () => ({
          projectionSequence: 10,
          threads: [],
          recentThreadIds: [],
          pinnedThreadIds: [],
        })),
        getStartupProjectCatalog: vi.fn(async () => ({
          projectionSequence: 10,
          projects: [],
          remainingCount: 0,
        })),
        getProjectThreadSummaries: vi.fn(),
        replayEvents,
      },
    } as unknown as NativeApi,
    replayEvents,
  };
}

describe("event application acknowledgement", () => {
  beforeEach(() => {
    vi.mocked(reconcileAppliedCanonicalOwnership).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears an accepted CRUD attempt when its canonical event is applied", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const command = {
      type: "thread.archive" as const,
      commandId: CommandId.makeUnsafe("canonical-event-command"),
      threadId: ThreadId.makeUnsafe("thread-1"),
    };
    const api = makeApi().api;
    api.orchestration.dispatchCommand = vi.fn(async () => ({ sequence: 11 }));
    await dispatchCommandWithOutcomeRecovery(api, command);
    expect(readPendingCommands()).toHaveLength(1);

    const recovery = createEventRouterRecovery({
      api,
      queryClient: new QueryClient(),
      clearAllThinkingDeltas: vi.fn(),
      reconcileThinkingActivities: vi.fn(),
      applyOrchestrationEvents: vi.fn(),
      syncProjects: vi.fn(),
      syncThreads: vi.fn(),
      clearThreadUi: vi.fn(),
      removeFromSelection: vi.fn(),
      removeTerminalState: vi.fn(),
      removeOrphanedTerminalStates: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });
    await recovery.runBoundedRecovery("bootstrap", null, () => false);
    await recovery.applyEventBatch([
      makeEvent(
        "thread.archived",
        {
          threadId: command.threadId,
          archivedAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:00.000Z",
        },
        { sequence: 11, commandId: command.commandId },
      ),
    ]);

    expect(readPendingCommands()).toHaveLength(0);
  });

  it("serializes concurrent pending flushes across asynchronous ownership reconciliation", async () => {
    const ownershipGate = deferred();
    vi.mocked(reconcileAppliedCanonicalOwnership)
      .mockImplementationOnce(() => ownershipGate.promise)
      .mockResolvedValue(undefined);
    const { api, replayEvents } = makeApi();
    const appliedSequences: number[][] = [];
    const recovery = createEventRouterRecovery({
      api,
      queryClient: new QueryClient(),
      clearAllThinkingDeltas: vi.fn(),
      reconcileThinkingActivities: vi.fn(),
      applyOrchestrationEvents: vi.fn((events: ReadonlyArray<OrchestrationEvent>) => {
        appliedSequences.push(events.map((event) => event.sequence));
      }),
      syncProjects: vi.fn(),
      syncThreads: vi.fn(),
      clearThreadUi: vi.fn(),
      removeFromSelection: vi.fn(),
      removeTerminalState: vi.fn(),
      removeOrphanedTerminalStates: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });
    await recovery.runBoundedRecovery("bootstrap", null, () => false);

    recovery.pushPendingDomainEvent(
      makeEvent(
        "thread.pinned",
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          pinnedAt: "2026-08-26T12:00:00.000Z",
          updatedAt: "2026-08-26T12:00:00.000Z",
        },
        { sequence: 11 },
      ),
    );
    const firstFlush = recovery.flushPendingDomainEvents(false);
    await vi.waitFor(() => expect(reconcileAppliedCanonicalOwnership).toHaveBeenCalledTimes(1));

    recovery.pushPendingDomainEvent(
      makeEvent(
        "thread.pinned",
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          pinnedAt: "2026-08-26T12:00:01.000Z",
          updatedAt: "2026-08-26T12:00:01.000Z",
        },
        { sequence: 12 },
      ),
    );
    const secondFlush = recovery.flushPendingDomainEvents(false);
    ownershipGate.resolve();
    await Promise.all([firstFlush, secondFlush]);
    await recovery.runReplayRecovery("sequence-gap", () => false, vi.fn());

    expect(appliedSequences).toEqual([[11], [12]]);
    expect(replayEvents).toHaveBeenLastCalledWith(12);
  });

  it("replays from the last applied sequence when required store application throws", async () => {
    const { api, replayEvents } = makeApi();
    const recovery = createEventRouterRecovery({
      api,
      queryClient: new QueryClient(),
      clearAllThinkingDeltas: vi.fn(),
      reconcileThinkingActivities: vi.fn(),
      applyOrchestrationEvents: vi.fn(() => {
        throw new Error("reducer failed");
      }),
      syncProjects: vi.fn(),
      syncThreads: vi.fn(),
      clearThreadUi: vi.fn(),
      removeFromSelection: vi.fn(),
      removeTerminalState: vi.fn(),
      removeOrphanedTerminalStates: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });
    await recovery.runBoundedRecovery("bootstrap", null, () => false);

    await expect(
      recovery.applyEventBatch([
        makeEvent(
          "thread.pinned",
          {
            threadId: ThreadId.makeUnsafe("thread-1"),
            pinnedAt: "2026-08-26T12:00:00.000Z",
            updatedAt: "2026-08-26T12:00:00.000Z",
          },
          {
            sequence: 11,
          },
        ),
      ]),
    ).rejects.toThrow("reducer failed");
    await recovery.runReplayRecovery("sequence-gap", () => false, vi.fn());

    expect(replayEvents).toHaveBeenCalledWith(10);
  });
});
