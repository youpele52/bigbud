import type { OrchestrationEvent, OrchestrationReadModel, ThreadId } from "@bigbud/contracts";

import {
  createMobileOrchestrationSyncController,
  type MobileOrchestrationSyncController,
} from "./mobileOrchestrationSync.logic";
import { installMobileSelectedThread } from "./mobileRecovery.cache";
import { readLegacyMobileBaseline } from "./mobileRecovery.legacy";
import { applyMobileRecoveryFrame } from "./mobileRecovery.frames";
import {
  defaultRecoveryScheduler,
  initialMobileRecoveryState,
  isMobileRecoveryBaselineConsistent,
  isUnsupportedRecoveryError,
  makeAttemptId,
  MOBILE_RECOVERY_ATTEMPT_TIMEOUT_MS,
  MAX_RETRY_ATTEMPTS,
  recoveryErrorMessage,
  RETRY_DELAYS_MS,
  snapshotKey,
  type MobileRecoveryBaseline,
  type MobileRecoveryController,
  type MobileRecoveryFrame,
  type MobileRecoveryState,
  type RecoveryClient,
  type RecoveryQueryClient,
  type RecoveryScheduler,
} from "./mobileRecovery.types";
import { createMobileRecoveryStabilityTimer } from "./mobileRecovery.stability";
import { createMobileRecoveryEventTracker } from "./mobileRecovery.tracking";

export type { MobileRecoveryController, MobileRecoveryState } from "./mobileRecovery.types";

export function createMobileRecoveryController(input: {
  readonly client: RecoveryClient;
  readonly queryClient: RecoveryQueryClient;
  readonly sessionId: string;
  readonly scheduler?: RecoveryScheduler;
  readonly makeAttemptId?: (generation: number) => string;
}): MobileRecoveryController {
  const scheduler = input.scheduler ?? defaultRecoveryScheduler();
  const sync: MobileOrchestrationSyncController = createMobileOrchestrationSyncController({
    queryClient: input.queryClient,
    sessionId: input.sessionId,
    scheduler,
    onUnhandledEvent: () => {
      if (state.freshness !== "unavailable" && state.freshness !== "stale") {
        failCurrentAttempt("unknown-event");
      }
    },
    onQueueOverflow: () => failCurrentAttempt("overflow"),
  });
  const listeners = new Set<() => void>();
  let state = initialMobileRecoveryState("refreshing");
  let active = false;
  let disposed = false;
  let generation = 0;
  let selectedThreadId: ThreadId | null = null;
  let retryOrdinal = 0;
  const stability = createMobileRecoveryStabilityTimer(scheduler, () => {
    retryOrdinal = 0;
  });
  let retryTimer: number | null = null;
  let baselineAbort: AbortController | null = null;
  let streamCancel: (() => void) | null = null;
  let attemptDeadlineAt = 0;
  let attemptTimeoutTimer: number | null = null;
  let streamStopExpected = false;
  let legacyUnsubscribe: (() => void) | null = null;
  const eventTracker = createMobileRecoveryEventTracker();
  let inFlight: {
    readonly selectedThreadId: ThreadId | null;
    readonly promise: Promise<MobileRecoveryBaseline>;
  } | null = null;
  function setState(next: Partial<MobileRecoveryState>) {
    state = { ...state, ...next };
    stability.update(state.freshness);
    for (const listener of listeners) listener();
  }
  function hasCachedSnapshot() {
    return (
      input.queryClient.getQueryData?.<OrchestrationReadModel>(snapshotKey(input.sessionId)) !==
      undefined
    );
  }
  function cancelTransport() {
    stability.cancel();
    baselineAbort?.abort();
    baselineAbort = null;
    clearAttemptTimeout();
    if (streamCancel !== null) {
      streamStopExpected = true;
      streamCancel();
      streamCancel = null;
    }
    legacyUnsubscribe?.();
    legacyUnsubscribe = null;
  }
  function failCurrentAttempt(reason: string) {
    if (disposed || !active) return;
    generation += 1;
    inFlight = null;
    cancelTransport();
    sync.reset();
    eventTracker.reset();
    markStale(reason);
    scheduleRetry();
  }
  function armAttemptTimeout(runGeneration: number) {
    attemptTimeoutTimer = scheduler.setTimeout(
      () => {
        if (runGeneration === generation) failCurrentAttempt("recovery-timeout");
      },
      Math.max(0, attemptDeadlineAt - Date.now()),
    );
  }
  function clearAttemptTimeout() {
    if (attemptTimeoutTimer === null) return;
    scheduler.clearTimeout(attemptTimeoutTimer);
    attemptTimeoutTimer = null;
  }
  function clearRetry() {
    if (retryTimer !== null) {
      scheduler.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function markStale(reason: string) {
    if (disposed) return;
    setState({
      freshness: hasCachedSnapshot() ? "stale" : "unavailable",
      reason,
      actionsAvailable: false,
    });
  }

  function scheduleRetry() {
    if (disposed || retryTimer !== null || retryOrdinal >= MAX_RETRY_ATTEMPTS) return;
    const delay = RETRY_DELAYS_MS[retryOrdinal] ?? RETRY_DELAYS_MS.at(-1)!;
    retryOrdinal += 1;
    retryTimer = scheduler.setTimeout(() => {
      retryTimer = null;
      void beginAttempt().catch(() => undefined);
    }, delay);
  }

  function installBaseline(baseline: MobileRecoveryBaseline) {
    sync.reset();
    eventTracker.reset();
    input.queryClient.setQueryData<OrchestrationReadModel>(
      snapshotKey(input.sessionId),
      () => baseline.snapshot,
    );
    installMobileSelectedThread(input.queryClient, input.sessionId, selectedThreadId, baseline);
    setState({
      freshness: "refreshing",
      snapshotSequence: baseline.snapshotSequence,
      throughSequence: baseline.snapshotSequence,
      selectedThreadStatus:
        selectedThreadId === null ? "none" : (baseline.selectedThread?.status ?? "unknown"),
      reason: null,
      actionsAvailable: false,
    });
  }

  function handleFrame(
    frame: MobileRecoveryFrame,
    runGeneration: number,
    attemptId: string,
    serverEpoch: string,
  ) {
    if (!active || disposed || runGeneration !== generation) return;
    applyMobileRecoveryFrame({
      frame,
      runGeneration,
      expectedAttemptId: attemptId,
      expectedServerEpoch: serverEpoch,
      state,
      currentGeneration: () => generation,
      tracker: eventTracker,
      queueEvent: sync.queueEvent,
      flush: sync.flush,
      clearAttemptTimeout,
      setState,
      fail: failCurrentAttempt,
    });
  }
  function handleStreamExit(runGeneration: number) {
    if (!active || disposed || runGeneration !== generation) return;
    if (streamStopExpected) {
      streamStopExpected = false;
      return;
    }
    failCurrentAttempt("recovery-stream-ended");
  }
  async function installLegacy(runGeneration: number): Promise<MobileRecoveryBaseline> {
    const requestedSelectedThreadId = selectedThreadId;
    const abortController = new AbortController();
    baselineAbort = abortController;
    const baseline = await readLegacyMobileBaseline({
      client: input.client,
      recoveryAttemptId: `legacy-${runGeneration}`,
      selectedThreadId: requestedSelectedThreadId,
      isCurrent: () => active && !disposed && runGeneration === generation,
      signal: abortController.signal,
    });
    baselineAbort = null;
    clearAttemptTimeout();
    sync.reset();
    eventTracker.reset();
    input.queryClient.setQueryData<OrchestrationReadModel>(
      snapshotKey(input.sessionId),
      () => baseline.snapshot,
    );
    installMobileSelectedThread(input.queryClient, input.sessionId, selectedThreadId, baseline);
    setState({
      freshness: "legacy",
      lastRefreshedAt: Date.now(),
      snapshotSequence: baseline.snapshotSequence,
      throughSequence: null,
      selectedThreadStatus:
        requestedSelectedThreadId === null
          ? "none"
          : (baseline.selectedThread?.status ?? "unknown"),
      reason: "recovery-unsupported",
      actionsAvailable: true,
    });
    legacyUnsubscribe = input.client.onDomainEvent((event) => {
      if (runGeneration === generation && active && !disposed) {
        sync.queueEvent(event as OrchestrationEvent);
      }
    });
    return baseline;
  }
  function startStream(baseline: MobileRecoveryBaseline, runGeneration: number) {
    const attemptId = baseline.recoveryAttemptId;
    const serverEpoch = baseline.serverEpoch;
    streamStopExpected = false;
    try {
      const cancel = input.client.startMobileRecoveryStream({
        recoveryAttemptId: attemptId,
        serverEpoch,
        baselineSequence: baseline.snapshotSequence,
        dispatchFrame: (frame) => handleFrame(frame, runGeneration, attemptId, serverEpoch),
        onError: (error) => {
          if (runGeneration !== generation || disposed) return;
          if (isUnsupportedRecoveryError(error)) {
            generation += 1;
            cancelTransport();
            sync.reset();
            eventTracker.reset();
            const legacyGeneration = generation;
            armAttemptTimeout(legacyGeneration);
            markStale("recovery-unsupported");
            void installLegacy(legacyGeneration).catch(() => {
              if (legacyGeneration === generation) failCurrentAttempt("legacy-fallback-failed");
            });
            return;
          }
          failCurrentAttempt("recovery-stream-error");
        },
        onExit: () => handleStreamExit(runGeneration),
      });
      if (disposed || !active || runGeneration !== generation) {
        streamStopExpected = true;
        cancel();
        streamStopExpected = false;
        return;
      }
      streamCancel = cancel;
    } catch {
      failCurrentAttempt("recovery-stream-start-failed");
    }
  }

  async function beginAttempt(): Promise<MobileRecoveryBaseline> {
    clearRetry();
    const runGeneration = ++generation;
    cancelTransport();
    sync.reset();
    eventTracker.reset();
    const attemptId = (input.makeAttemptId ?? makeAttemptId)(runGeneration);
    const abortController = new AbortController();
    baselineAbort = abortController;
    attemptDeadlineAt = Date.now() + MOBILE_RECOVERY_ATTEMPT_TIMEOUT_MS;
    armAttemptTimeout(runGeneration);
    setState({ freshness: "refreshing", reason: null, actionsAvailable: false });
    try {
      const baseline = await input.client.getMobileRecoveryBaseline(
        {
          recoveryAttemptId: attemptId,
          ...(selectedThreadId === null ? {} : { selectedThreadId }),
        },
        abortController.signal,
      );
      if (!active || disposed || runGeneration !== generation) {
        throw new Error("Mobile recovery attempt was superseded.");
      }
      if (!isMobileRecoveryBaselineConsistent(baseline, attemptId, selectedThreadId)) {
        throw new Error("Mobile recovery baseline consistency check failed.");
      }
      installBaseline(baseline);
      startStream(baseline, runGeneration);
      return baseline;
    } catch (error) {
      if (!active || disposed || runGeneration !== generation) throw error;
      if (isUnsupportedRecoveryError(error)) {
        try {
          return await installLegacy(runGeneration);
        } catch (legacyError) {
          if (!active || disposed || runGeneration !== generation) throw legacyError;
          clearAttemptTimeout();
          markStale("legacy-fallback-failed");
          scheduleRetry();
          throw legacyError;
        }
      }
      clearAttemptTimeout();
      markStale(recoveryErrorMessage(error));
      scheduleRetry();
      throw error;
    } finally {
      if (runGeneration === generation) baselineAbort = null;
    }
  }

  function requestRecovery(nextSelectedThreadId: ThreadId | null, resetRetries: boolean) {
    if (disposed) return Promise.reject(new Error("Mobile recovery controller is disposed."));
    selectedThreadId = nextSelectedThreadId;
    setState({
      selectedThreadId: nextSelectedThreadId,
      selectedThreadStatus: nextSelectedThreadId === null ? "none" : "unknown",
    });
    if (inFlight !== null && inFlight.selectedThreadId === nextSelectedThreadId) {
      return inFlight.promise;
    }
    if (resetRetries) retryOrdinal = 0;
    const promise = beginAttempt();
    inFlight = { selectedThreadId: nextSelectedThreadId, promise };
    void promise.then(
      () => {
        if (inFlight?.promise === promise) inFlight = null;
      },
      () => {
        if (inFlight?.promise === promise) inFlight = null;
      },
    );
    return promise;
  }

  return {
    transportOpened() {
      if (active && !disposed && state.freshness !== "refreshing") scheduleRetry();
    },
    transportClosed() {
      if (state.freshness !== "stale" && state.freshness !== "unavailable") {
        failCurrentAttempt("transport-closed");
      }
    },
    start() {
      if (active || disposed) return;
      active = true;
      void requestRecovery(selectedThreadId, true).catch(() => undefined);
    },
    refresh(nextSelectedThreadId?: ThreadId | null) {
      return requestRecovery(
        nextSelectedThreadId === undefined ? selectedThreadId : nextSelectedThreadId,
        true,
      );
    },
    selectThread(threadId: ThreadId) {
      return requestRecovery(threadId, true);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState() {
      return state;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      clearRetry();
      cancelTransport();
      sync.reset();
      sync.dispose();
      listeners.clear();
    },
  } satisfies MobileRecoveryController;
}
