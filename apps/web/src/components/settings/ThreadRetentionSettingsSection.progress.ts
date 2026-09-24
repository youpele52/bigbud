import type { ServerThreadRetentionRun } from "@bigbud/contracts/server/threadRetention";
import type {
  ThreadRetentionAgeCriterion,
  ThreadRetentionSelectionMode,
} from "@bigbud/contracts/core/settings.threadRetention";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureNativeApi } from "../../rpc/nativeApi";
import { toastManager } from "../ui/toast";
import {
  getRetentionPollIntervalMs,
  isActiveRetentionRun,
  shouldReplaceRetentionRun,
} from "./ThreadRetentionSettingsSection.logic";

const STORAGE_KEY = "bigbud.manualThreadRetentionRunId";
const HEARTBEAT_MS = 5 * 60_000;
const toastIds = new Map<string, ReturnType<typeof toastManager.add>>();
const lastToast = new Map<string, { at: number; signature: string }>();

function storedRunId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeRunId(runId: string | null): void {
  try {
    if (runId) window.localStorage.setItem(STORAGE_KEY, runId);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Browser storage may be unavailable. */
  }
}

export function formatRetentionResourceOutcomes(run: ServerThreadRetentionRun): string {
  const shared = run.retainedSharedResourceCount ?? 0;
  const external = run.retainedExternalResourceCount ?? 0;
  const unverified = run.unverifiedResourceCount ?? 0;
  const blocked = run.blockedResourceCount ?? 0;
  const pending = run.pendingResourceCount ?? 0;
  const parts = [
    [shared, "shared"],
    [external, "external"],
    [unverified, "unverified"],
    [blocked, "blocked"],
    [pending, "pending"],
  ] as const;
  const reported = parts
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  if (reported.length === 0 && (run.retainedResourceCount ?? 0) > 0)
    reported.push(`${run.retainedResourceCount} retained`);
  return reported.join(", ");
}

export function retentionToast(run: ServerThreadRetentionRun) {
  const outcomes = formatRetentionResourceOutcomes(run);
  const retained = Math.max(
    run.retainedResourceCount ?? 0,
    (run.retainedSharedResourceCount ?? 0) +
      (run.retainedExternalResourceCount ?? 0) +
      (run.unverifiedResourceCount ?? 0),
  );
  const blocked = run.blockedResourceCount ?? 0;
  const pending = run.pendingResourceCount ?? 0;
  const uncertain = run.uncertainCount ?? 0;
  const total = Math.max(run.eligibleCount, run.selectedCount);
  if (run.status === "failed")
    return {
      type: "error" as const,
      title: `Cleanup failed: ${run.completedCount}/${total} deleted${outcomes ? ` · ${outcomes}` : ""}.`,
      timeout: 8_000,
    };
  if (run.status === "completed_with_failures" || retained > 0 || blocked > 0)
    return {
      type: "warning" as const,
      title: `Cleanup: ${run.completedCount}/${total} deleted · ${outcomes || `${run.skippedCount} skipped`}.`,
      timeout: isActiveRetentionRun(run) ? 0 : 8_000,
    };
  if (!isActiveRetentionRun(run))
    return {
      type: "success" as const,
      title: `Cleanup finished: ${run.completedCount} threads deleted.`,
      timeout: 8_000,
    };
  return {
    type: "loading" as const,
    title: `Cleanup: ${run.completedCount}/${total} deleted · ${uncertain} outcomes, ${pending} resources pending.`,
    timeout: 0,
  };
}

export function publishRunToast(run: ServerThreadRetentionRun, force = false): void {
  const payload = retentionToast(run);
  const signature = `${run.status}:${run.completedCount}:${run.skippedCount}:${run.failedCount}:${
    run.completedResourceCount ?? 0
  }:${run.retainedResourceCount ?? 0}:${run.blockedResourceCount ?? 0}:${run.uncertainCount ?? 0}:${
    run.pendingResourceCount ?? 0
  }:${run.retainedSharedResourceCount ?? 0}:${run.retainedExternalResourceCount ?? 0}:${
    run.unverifiedResourceCount ?? 0
  }`;
  const now = Date.now();
  const previous = lastToast.get(run.runId);
  if (!force && previous?.signature === signature && now - previous.at < HEARTBEAT_MS) return;
  const toastId = toastIds.get(run.runId);
  if (toastId === undefined) toastIds.set(run.runId, toastManager.add(payload));
  else if (force) toastManager.add({ ...payload, id: toastId });
  else toastManager.update(toastId, payload);
  lastToast.set(run.runId, { at: now, signature });
}

export function publishReconnectToast(runId: string): void {
  lastToast.delete(runId);
  const payload = {
    type: "loading" as const,
    title: "Cleanup: reconnecting for progress…",
    timeout: 0,
  };
  const toastId = toastIds.get(runId);
  if (toastId === undefined) toastIds.set(runId, toastManager.add(payload));
  else toastManager.add({ ...payload, id: toastId });
}

export function useThreadRetentionProgress() {
  const [runId, setRunId] = useState<string | null>(storedRunId);
  const [run, setRun] = useState<ServerThreadRetentionRun | null>(null);
  const [recentRuns, setRecentRuns] = useState<ReadonlyArray<ServerThreadRetentionRun>>([]);
  const [policyMode, setPolicyMode] = useState<ThreadRetentionSelectionMode | null>(null);
  const [policyCriterion, setPolicyCriterion] = useState<ThreadRetentionAgeCriterion>(
    "last-conversation-activity",
  );
  const latestRef = useRef<ServerThreadRetentionRun | null>(null);

  const refreshRecent = useCallback(async () => {
    const recent = await ensureNativeApi().server.listThreadRetentionRuns({ limit: 10 });
    setRecentRuns(recent.runs);
    setPolicyMode(recent.policySelectionMode ?? "legacy-subtree");
    setPolicyCriterion(recent.policyAgeCriterion ?? "last-conversation-activity");
  }, []);

  const beginRun = useCallback((accepted: ServerThreadRetentionRun) => {
    storeRunId(accepted.runId);
    setRunId(accepted.runId);
    setRun(accepted);
    latestRef.current = accepted;
    publishRunToast(accepted, true);
  }, []);

  useEffect(() => {
    void refreshRecent().catch(() => {});
  }, [refreshRecent]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await ensureNativeApi().server.getThreadRetentionRun({ runId });
        if (cancelled) return;
        if (shouldReplaceRetentionRun(latestRef.current, next)) {
          const firstPoll = latestRef.current === null;
          latestRef.current = next;
          setRun(next);
          publishRunToast(next, firstPoll);
        }
        if (!isActiveRetentionRun(next)) {
          storeRunId(null);
          void refreshRecent().catch(() => {});
          return;
        }
        timer = setTimeout(poll, getRetentionPollIntervalMs(next) ?? 2_000);
      } catch {
        if (cancelled) return;
        publishReconnectToast(runId);
        timer = setTimeout(poll, 5_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, refreshRecent]);

  return { run, recentRuns, policyMode, policyCriterion, beginRun, refreshRecent };
}
