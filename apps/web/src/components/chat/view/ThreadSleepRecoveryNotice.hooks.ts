import type { ThreadId } from "@bigbud/contracts";
import type {
  ThreadRecovery,
  ThreadRecoveryResolveAction,
} from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { newCommandId } from "../../../lib/utils";
import { readNativeApi } from "../../../rpc/nativeApi";
import { toastManager } from "../../ui/toast";
import { observeSleepRecoveryState } from "./ThreadRecoveryNotice.clock";
import {
  buildThreadRecoveryResolveCommand,
  deriveSleepRecoveryNotice,
  sleepRecoveryStateKey,
} from "./ThreadSleepRecoveryNotice.logic";

/** The current notice, re-derived when its 3 s hide or 6 s visibility ends. */
export function useSleepRecoveryNotice(threadId: ThreadId, recovery: ThreadRecovery | null) {
  const stateKey = recovery ? sleepRecoveryStateKey(recovery) : null;
  const observedAtMs = useMemo(
    () => (stateKey === null ? null : observeSleepRecoveryState(threadId, stateKey, Date.now())),
    [threadId, stateKey],
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const derivation = useMemo(
    () => deriveSleepRecoveryNotice({ recovery, observedAtMs, nowMs }),
    [recovery, observedAtMs, nowMs],
  );
  const { nextChangeInMs } = derivation;

  useEffect(() => {
    if (nextChangeInMs === null) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.max(0, nextChangeInMs));
    return () => window.clearTimeout(timer);
  }, [nextChangeInMs]);

  // A new state measures from the current time.
  useEffect(() => setNowMs(Date.now()), [stateKey]);

  return { notice: derivation.notice, stateKey };
}

/**
 * Dispatches `thread.recovery.resolve`. Buttons stay disabled while one action is in flight, so
 * a double click cannot send two continuations; the server also refuses a stale prompt.
 */
export function useResolveThreadRecovery(threadId: ThreadId) {
  const [pendingAction, setPendingAction] = useState<ThreadRecoveryResolveAction | null>(null);
  const resolve = useCallback(
    async (recovery: ThreadRecovery, action: ThreadRecoveryResolveAction) => {
      const api = readNativeApi();
      if (!api || pendingAction !== null) return;
      setPendingAction(action);
      try {
        await api.orchestration.dispatchCommand(
          buildThreadRecoveryResolveCommand({
            threadId,
            recovery,
            action,
            commandId: newCommandId(),
            createdAt: new Date().toISOString(),
          }),
        );
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not update this turn",
          description: error instanceof Error ? error.message : "Please try again.",
        });
      } finally {
        setPendingAction(null);
      }
    },
    [pendingAction, threadId],
  );
  return { resolve, pendingAction };
}
