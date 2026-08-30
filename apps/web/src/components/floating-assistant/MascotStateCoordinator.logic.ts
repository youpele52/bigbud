import {
  BUILT_IN_CHATS_PROJECT_ID,
  LOCAL_EXECUTION_TARGET_ID,
  type NativeApi,
  type OrchestrationDeliveryStreamItem,
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
import {
  recoverAndAcknowledgeDeliveryBaseline,
  routeOrchestrationDeliveryBatch,
} from "~/routes/-__root.delivery-routing";
import { createAsyncOperationQueue } from "~/routes/-__root.recovery.serial";
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
  const deliveryOperationQueue = createAsyncOperationQueue();
  const deliveryBaselineAbort = new AbortController();

  const applyAcceptedEvents = (events: ReadonlyArray<OrchestrationEvent>) => {
    if (events.length === 0) return;
    input.applyOrchestrationEvents(events);
  };

  const applyEventBatch = async (events: ReadonlyArray<OrchestrationEvent>) => {
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

  const runReplayRecovery = async (
    reason: "sequence-gap" | "resubscribe",
    fallbackToBoundedRecovery: () => Promise<void>,
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
        if (!disposed) await fallbackToBoundedRecovery();
        return;
      }
      recovery.observeReplayTarget(replay.latestSequence);
      if (!disposed) await applyEventBatch(replay.events);
    } catch (error) {
      replayRetryTracker = null;
      recovery.failReplayRecovery();
      logRecovery("Mascot replay recovery failed.", { error });
      if (!disposed) await fallbackToBoundedRecovery();
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
    await runReplayRecovery(reason, fallbackToBoundedRecovery);
  };

  const runBoundedRecovery = async (
    reason: "bootstrap" | "replay-failed",
    resumeReplay = true,
  ): Promise<number | null> => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (!recovery.beginSnapshotRecovery(reason)) return null;
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
      if (disposed) return null;
      const shouldReplay = recovery.completeSnapshotRecovery(projectionSequence);
      if (shouldReplay && resumeReplay) {
        await runReplayRecovery("sequence-gap", async () => {
          await runBoundedRecovery("replay-failed");
        });
      }
      return projectionSequence;
    } catch (error) {
      recovery.failSnapshotRecovery();
      logRecovery("Mascot catalog recovery failed.", { error });
      if (!disposed && import.meta.env.MODE !== "test") {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void deliveryOperationQueue
            .enqueue(() => runBoundedRecovery("bootstrap"))
            .catch((error) => {
              logRecovery("Mascot catalog recovery retry failed.", { error });
            });
        }, BOOTSTRAP_RETRY_MS);
      }
    }
    return null;
  };

  const fallbackToBoundedRecovery = async (): Promise<void> => {
    await runBoundedRecovery("replay-failed");
  };
  const processDeliveryItem = async (item: OrchestrationDeliveryStreamItem) => {
    if (disposed || item.type === "lifecycle") return;
    if (item.type === "recovery") {
      await recoverAndAcknowledgeDeliveryBaseline({
        recovery: item,
        recover: () => runBoundedRecovery("replay-failed", false),
        acknowledge: input.api.orchestration.acknowledgeDeliveryBaseline,
        signal: deliveryBaselineAbort.signal,
        shouldAbort: () => disposed,
      });
      return;
    }
    await routeOrchestrationDeliveryBatch({
      batch: item,
      classify: recovery.classifyDomainEvent.bind(recovery),
      recover: async () => {
        await runReplayRecovery("sequence-gap", fallbackToBoundedRecovery);
      },
      apply: applyEventBatch,
      getAppliedSequence: () => recovery.getState().appliedSequence,
      acknowledge: input.api.orchestration.acknowledgeDelivery,
    });
  };

  const enqueueDeliveryWork = (operation: () => Promise<unknown>): Promise<void> =>
    deliveryOperationQueue.enqueue(async () => {
      try {
        await operation();
      } catch (error) {
        logRecovery("Mascot delivery application failed.", { error });
        if (disposed) throw error;
        try {
          await fallbackToBoundedRecovery();
        } catch (recoveryError) {
          logRecovery("Mascot delivery recovery failed.", { error: recoveryError });
        }
        throw error;
      }
    });

  const unsubscribe = input.api.orchestration.onDomainEvent(
    (item) => enqueueDeliveryWork(() => processDeliveryItem(item)),
    {
      onResubscribe: () => {
        void enqueueDeliveryWork(() =>
          runReplayRecovery("resubscribe", fallbackToBoundedRecovery),
        ).catch((error) => {
          logRecovery("Mascot resubscribe recovery failed.", { error });
        });
      },
    },
  );

  void enqueueDeliveryWork(() => runBoundedRecovery("bootstrap")).catch((error) => {
    logRecovery("Mascot bootstrap recovery failed.", { error });
  });

  return () => {
    disposed = true;
    deliveryBaselineAbort.abort();
    if (retryTimer !== null) clearTimeout(retryTimer);
    unsubscribe();
  };
}
