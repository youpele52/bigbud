import type { ServerThreadRetentionRun } from "@bigbud/contracts/server/threadRetention";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureNativeApi } from "../../rpc/nativeApi";
import {
  getThreadRetentionRunWithRetry,
  isThreadRetentionPollingAbort,
} from "../../rpc/threadRetentionPolling";
import {
  getRetentionPollIntervalMs,
  RETENTION_LATEST_RUN_POLL_INTERVAL_MS,
  shouldReplaceRetentionRun,
} from "./ThreadRetentionSettingsSection.logic";

interface ThreadRetentionRunState {
  readonly latestRun: ServerThreadRetentionRun | null;
  readonly pollingError: string | null;
  readonly availability: "available" | "disabled" | "loading";
  readonly acceptRun: (run: ServerThreadRetentionRun) => void;
  readonly retryPolling: () => void;
}

export function useThreadRetentionRun(): ThreadRetentionRunState {
  const [latestRun, setLatestRun] = useState<ServerThreadRetentionRun | null>(null);
  const [pollingError, setPollingError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<"available" | "disabled" | "loading">("loading");
  const [retrySequence, setRetrySequence] = useState(0);
  const generationRef = useRef(0);
  const latestListRequestRef = useRef(0);
  const latestRunRef = useRef<ServerThreadRetentionRun | null>(null);

  const commitRun = useCallback((candidate: ServerThreadRetentionRun) => {
    const current = latestRunRef.current;
    if (shouldReplaceRetentionRun(current, candidate)) {
      latestRunRef.current = candidate;
      setLatestRun(candidate);
    }
    setPollingError(null);
  }, []);

  const acceptRun = useCallback(
    (run: ServerThreadRetentionRun) => {
      if (latestRunRef.current?.runId === run.runId) {
        commitRun(run);
        return;
      }
      generationRef.current += 1;
      latestListRequestRef.current += 1;
      latestRunRef.current = run;
      setLatestRun(run);
      setPollingError(null);
    },
    [commitRun],
  );

  const retryPolling = useCallback(() => {
    setPollingError(null);
    setRetrySequence((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadLatest = () => {
      const requestId = ++latestListRequestRef.current;
      void ensureNativeApi()
        .server.listThreadRetentionRuns({ limit: 1 })
        .then(({ runs, availability: nextAvailability }) => {
          if (cancelled || requestId !== latestListRequestRef.current) return;
          setAvailability(nextAvailability);
          const run = runs[0];
          if (run) acceptRun(run);
        })
        .catch((error: unknown) => {
          if (cancelled || requestId !== latestListRequestRef.current) return;
          const detail = error instanceof Error ? error.message : "The server did not respond.";
          setPollingError(`Could not load the latest retention run. ${detail}`);
        });
    };
    loadLatest();
    const intervalId = window.setInterval(loadLatest, RETENTION_LATEST_RUN_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [acceptRun, retrySequence]);

  useEffect(() => {
    if (!latestRun || pollingError) return;
    const pollIntervalMs = getRetentionPollIntervalMs(latestRun);
    if (pollIntervalMs === null) return;

    const controller = new AbortController();
    const generation = generationRef.current;
    const runId = latestRun.runId;
    const timeoutId = window.setTimeout(() => {
      void getThreadRetentionRunWithRetry(
        ensureNativeApi().server.getThreadRetentionRun,
        { runId },
        { signal: controller.signal },
      )
        .then((run) => {
          if (controller.signal.aborted || generation !== generationRef.current) return;
          commitRun(run);
        })
        .catch((error: unknown) => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current ||
            isThreadRetentionPollingAbort(error)
          ) {
            return;
          }
          const detail = error instanceof Error ? error.message : "The server did not respond.";
          setPollingError(
            `Live retention updates paused. ${detail} Check the connection, then retry.`,
          );
        });
    }, pollIntervalMs);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [commitRun, latestRun, pollingError, retrySequence]);

  return { latestRun, pollingError, availability, acceptRun, retryPolling };
}
