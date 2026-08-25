import {
  BUILT_IN_CHATS_PROJECT_ID,
  ThreadId,
  TurnId,
  type GetSidebarThreadCatalogResult,
  type GetStartupProjectCatalogResult,
  type NativeApi,
  type OrchestrationEvent,
  type OrchestrationReplayEventsResult,
} from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deriveMascotWorkAnimation } from "~/components/floating-assistant/mascotAnimation.logic";
import { useStore } from "~/stores/main";
import { makeEvent } from "~/stores/main/main.store.test.helpers";

import { startMascotOrchestrationSync } from "./MascotStateCoordinator.logic";

const NOW = "2026-08-16T12:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("mascot-thread");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("other-running-thread");
const TURN_ID = TurnId.makeUnsafe("mascot-turn");

function emptyCatalog(sequence: number): GetStartupProjectCatalogResult {
  return {
    projectionSequence: sequence,
    projects: [],
    remainingCount: 0,
  };
}

function runningSummary(threadId: ThreadId): GetSidebarThreadCatalogResult["threads"][number] {
  return {
    id: threadId,
    projectId: BUILT_IN_CHATS_PROJECT_ID,
    title: "Working",
    purpose: "standard",
    elevatorSummary: "Working",
    modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
    latestUserMessageAt: NOW,
    pinnedAt: null,
    sessionStatus: "running",
    providerName: "codex",
    activeTurnId: TURN_ID,
    latestTurnState: "running",
    isWatching: false,
    isWatched: false,
    isDelegated: false,
    isAwaitingApproval: false,
  };
}

function makeApi(options: {
  readonly sidebarThreads?: GetSidebarThreadCatalogResult["threads"];
  readonly projectionSequence?: number;
  readonly replayEvents?: OrchestrationEvent[];
}) {
  const projectionSequence = options.projectionSequence ?? 10;
  const listeners = new Set<(event: OrchestrationEvent) => void>();
  const orchestration = {
    getSnapshot: vi.fn(),
    getSidebarThreadCatalog: vi.fn(
      async (): Promise<GetSidebarThreadCatalogResult> => ({
        projectionSequence,
        threads: options.sidebarThreads ?? [runningSummary(THREAD_ID)],
        recentThreadIds: options.sidebarThreads?.map((thread) => thread.id) ?? [THREAD_ID],
        pinnedThreadIds: [],
      }),
    ),
    getStartupProjectCatalog: vi.fn(async () => emptyCatalog(projectionSequence)),
    getProjectThreadSummaries: vi.fn(),
    replayEvents: vi.fn(
      async (fromSequenceExclusive: number): Promise<OrchestrationReplayEventsResult> => ({
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: 1,
        latestSequence: Math.max(
          fromSequenceExclusive,
          options.replayEvents?.at(-1)?.sequence ?? fromSequenceExclusive,
        ),
        availability: "available",
        complete: true,
        events: options.replayEvents ?? [],
      }),
    ),
    onDomainEvent: vi.fn((listener: (event: OrchestrationEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };

  return {
    api: { orchestration } as unknown as NativeApi,
    orchestration,
    emit: (event: OrchestrationEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("mascot orchestration sync", () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState());
  });

  it("hydrates running session state from the bounded catalog without getSnapshot", async () => {
    const { api, orchestration } = makeApi({});
    const stop = startMascotOrchestrationSync({
      api,
      applyOrchestrationEvents: (events) => useStore.getState().applyOrchestrationEvents(events),
    });

    try {
      await vi.waitFor(() => {
        expect(deriveMascotWorkAnimation(useStore.getState().threads)).toBe("thinking");
      });
      expect(orchestration.getSnapshot).not.toHaveBeenCalled();
      expect(orchestration.getSidebarThreadCatalog).toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("applies live session events after bootstrap instead of refetching a full snapshot", async () => {
    const { api, orchestration, emit } = makeApi({
      sidebarThreads: [
        {
          ...runningSummary(THREAD_ID),
          sessionStatus: "ready",
          activeTurnId: null,
          latestTurnState: null,
        },
      ],
    });
    const stop = startMascotOrchestrationSync({
      api,
      applyOrchestrationEvents: (events) => useStore.getState().applyOrchestrationEvents(events),
    });

    try {
      await vi.waitFor(() => {
        expect(useStore.getState().threads).toHaveLength(1);
      });
      expect(deriveMascotWorkAnimation(useStore.getState().threads)).toBe("okay");

      emit(
        makeEvent(
          "thread.session-set",
          {
            threadId: THREAD_ID,
            session: {
              threadId: THREAD_ID,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TURN_ID,
              sessionEpoch: 0,
              reason: null,
              lastError: null,
              updatedAt: NOW,
            },
          },
          { sequence: 11 },
        ),
      );

      await vi.waitFor(() => {
        expect(deriveMascotWorkAnimation(useStore.getState().threads)).toBe("thinking");
      });
      expect(orchestration.getSnapshot).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("replays sequence gaps and materializes unknown running threads without getSnapshot", async () => {
    const { api, orchestration, emit } = makeApi({
      sidebarThreads: [],
      replayEvents: [
        makeEvent(
          "thread.session-set",
          {
            threadId: OTHER_THREAD_ID,
            session: {
              threadId: OTHER_THREAD_ID,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TURN_ID,
              sessionEpoch: 0,
              reason: null,
              lastError: null,
              updatedAt: NOW,
            },
          },
          { sequence: 11 },
        ),
      ],
    });
    const stop = startMascotOrchestrationSync({
      api,
      applyOrchestrationEvents: (events) => useStore.getState().applyOrchestrationEvents(events),
    });

    try {
      await vi.waitFor(() => {
        expect(useStore.getState().bootstrapComplete).toBe(true);
      });

      emit(
        makeEvent(
          "thread.session-set",
          {
            threadId: OTHER_THREAD_ID,
            session: {
              threadId: OTHER_THREAD_ID,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TURN_ID,
              sessionEpoch: 0,
              reason: null,
              lastError: null,
              updatedAt: NOW,
            },
          },
          { sequence: 12 },
        ),
      );

      await vi.waitFor(() => {
        expect(orchestration.replayEvents).toHaveBeenCalled();
        expect(deriveMascotWorkAnimation(useStore.getState().threads)).toBe("thinking");
      });
      expect(orchestration.getSnapshot).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
