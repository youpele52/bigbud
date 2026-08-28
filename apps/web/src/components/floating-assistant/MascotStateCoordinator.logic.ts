import {
  BUILT_IN_CHATS_PROJECT_ID,
  LOCAL_EXECUTION_TARGET_ID,
  type NativeApi,
  type OrchestrationEvent,
  type ThreadId,
} from "@bigbud/contracts";

import {
  createOrchestrationRecoveryCoordinator,
  deriveReplayRetryDecision,
  retryTransportRecoveryOperation,
  type ReplayRetryTracker,
  RECOVERY_OPERATION_TIMEOUT_MS,
} from "~/logic/orchestration";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "~/models/types";
import { runBoundedBootstrap } from "~/routes/-__root.bounded-bootstrap";
import { mapSession } from "~/stores/main/mappers.store";
import { useStore } from "~/stores/main";

const BOOTSTRAP_RETRY_MS = 1_000;
const REPLAY_RECOVERY_RETRY_DELAY_MS = 100;
const MAX_NO_PROGRESS_REPLAY_RETRIES = 3;

function eventThreadId(event: OrchestrationEvent): ThreadId | null {
  if ("threadId" in event.payload && typeof event.payload.threadId === "string") {
    return event.payload.threadId;
  }
  return null;
}

function placeholderThread(
  threadId: ThreadId,
  session: Thread["session"],
  updatedAt: string,
): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: BUILT_IN_CHATS_PROJECT_ID,
    providerRuntimeExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
    workspaceExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
    executionTargetId: LOCAL_EXECUTION_TARGET_ID,
    title: "",
    purpose: "standard",
    elevatorSummary: "",
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: updatedAt,
    archivedAt: null,
    pinnedAt: null,
    deletingAt: null,
    updatedAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };
}

function ensurePlaceholderThread(event: OrchestrationEvent) {
  const threadId = eventThreadId(event);
  if (threadId === null) return;
  if (useStore.getState().threads.some((thread) => thread.id === threadId)) return;
  const session = event.type === "thread.session-set" ? mapSession(event.payload.session) : null;
  const updatedAt = event.occurredAt;
  useStore.setState((state) => ({
    threads: [...state.threads, placeholderThread(threadId, session, updatedAt)],
  }));
}

function logRecovery(message: string, details?: Record<string, unknown>) {
  if (import.meta.env.MODE === "test") return;
  console.warn("[orchestration-recovery]", message, details);
}

export function startMascotOrchestrationSync(input: {
  readonly api: NativeApi;
  readonly applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
}): () => void {
  const recovery = createOrchestrationRecoveryCoordinator();
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let replayRetryTracker: ReplayRetryTracker | null = null;
  const pendingEvents: OrchestrationEvent[] = [];
  let flushScheduled = false;

  const applyAcceptedEvents = (events: ReadonlyArray<OrchestrationEvent>) => {
    if (events.length === 0) return;
    input.applyOrchestrationEvents(events);
  };

  const applyEventBatch = (events: ReadonlyArray<OrchestrationEvent>) => {
    const admitted = recovery.admitEventBatch(events);
    if (admitted.length === 0) return;
    try {
      for (const event of admitted) ensurePlaceholderThread(event);
      applyAcceptedEvents(admitted);
      recovery.commitEventBatchApplied(admitted);
      recovery.acknowledgeAppliedSequence(admitted.at(-1)!.sequence);
    } catch (error) {
      recovery.markApplicationFailed();
      throw error;
    }
  };

  const flushPendingEvents = () => {
    flushScheduled = false;
    if (disposed || pendingEvents.length === 0) return;
    applyEventBatch(pendingEvents.splice(0, pendingEvents.length));
  };

  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      try {
        flushPendingEvents();
      } catch (error) {
        logRecovery("Mascot event application failed.", { error });
        void runReplayRecovery("sequence-gap", () => {
          void runBoundedRecovery("replay-failed");
        });
      }
    });
  };

  const runReplayRecovery = async (
    reason: "sequence-gap" | "resubscribe",
    fallbackToBoundedRecovery: () => void,
  ): Promise<void> => {
    if (!recovery.beginReplayRecovery(reason)) return;
    const fromSequenceExclusive = recovery.getState().latestSequence;
    try {
      const replay = await retryTransportRecoveryOperation(
        () => input.api.orchestration.replayEvents(fromSequenceExclusive),
        { shouldAbort: () => disposed, timeoutMs: RECOVERY_OPERATION_TIMEOUT_MS },
      );
      if (replay.availability === "gap") {
        replayRetryTracker = null;
        recovery.failReplayRecovery();
        if (!disposed) fallbackToBoundedRecovery();
        return;
      }
      recovery.observeReplayTarget(replay.latestSequence);
      if (!disposed) applyEventBatch(replay.events);
    } catch (error) {
      replayRetryTracker = null;
      recovery.failReplayRecovery();
      logRecovery("Mascot replay recovery failed.", { error });
      if (!disposed) fallbackToBoundedRecovery();
      return;
    }
    if (disposed) return;
    const replayCompletion = recovery.completeReplayRecovery();
    const retryDecision = deriveReplayRetryDecision({
      previousTracker: replayRetryTracker,
      completion: replayCompletion,
      recoveryState: recovery.getState(),
      baseDelayMs: REPLAY_RECOVERY_RETRY_DELAY_MS,
      maxNoProgressRetries: MAX_NO_PROGRESS_REPLAY_RETRIES,
    });
    replayRetryTracker = retryDecision.tracker;
    if (!retryDecision.shouldRetry) {
      if (replayCompletion.shouldReplay) {
        logRecovery("Stopping mascot replay recovery after no-progress retries.", {
          state: recovery.getState(),
        });
      }
      return;
    }
    if (retryDecision.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDecision.delayMs);
      });
      if (disposed) return;
    }
    void runReplayRecovery(reason, fallbackToBoundedRecovery);
  };

  const runBoundedRecovery = async (reason: "bootstrap" | "replay-failed"): Promise<void> => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (!recovery.beginSnapshotRecovery(reason)) return;
    try {
      const projectionSequence = await retryTransportRecoveryOperation(
        () =>
          runBoundedBootstrap({
            api: input.api,
            selectedThreadId: null,
            disposed: () => disposed,
          }),
        { shouldAbort: () => disposed, timeoutMs: RECOVERY_OPERATION_TIMEOUT_MS },
      );
      if (disposed) return;
      if (recovery.completeSnapshotRecovery(projectionSequence)) {
        void runReplayRecovery("sequence-gap", () => {
          void runBoundedRecovery("replay-failed");
        });
      }
    } catch (error) {
      recovery.failSnapshotRecovery();
      logRecovery("Mascot catalog recovery failed.", { error });
      if (!disposed && import.meta.env.MODE !== "test") {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void runBoundedRecovery("bootstrap");
        }, BOOTSTRAP_RETRY_MS);
      }
    }
  };

  const unsubscribe = input.api.orchestration.onDomainEvent(
    (item) => {
      if (item.type !== "batch") return;
      for (const event of item.events) {
        const action = recovery.classifyDomainEvent(event.sequence);
        if (action === "apply") {
          pendingEvents.push(event);
          scheduleFlush();
          continue;
        }
        if (action === "recover") {
          flushPendingEvents();
          void runReplayRecovery("sequence-gap", () => {
            void runBoundedRecovery("replay-failed");
          });
        }
      }
    },
    {
      onResubscribe: () => {
        flushPendingEvents();
        void runReplayRecovery("resubscribe", () => {
          void runBoundedRecovery("replay-failed");
        });
      },
    },
  );

  void runBoundedRecovery("bootstrap");

  return () => {
    disposed = true;
    pendingEvents.length = 0;
    if (retryTimer !== null) clearTimeout(retryTimer);
    unsubscribe();
  };
}
