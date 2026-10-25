import type { ServerConfig, ServerConfigStreamEvent } from "@bigbud/contracts/server/server";
import type { ServerLifecycleWelcomePayload } from "@bigbud/contracts/server/server.lifecycle.ts";
import type { ServerStalledPayload } from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { Cause, Duration, Schema } from "effect";

import type { WsRpcClient } from "./wsRpcClient.types";
import {
  beginServerConfigReadiness,
  getServerConfigReadiness,
  registerServerConfigRetry,
  MAX_CONFIG_NO_PROGRESS_FAILURES,
  updateServerConfigReadiness,
  type ConfigFailureCategory,
} from "./serverConfigReadiness";
import {
  isWsSubscriptionListenerFailure,
  WsSubscriptionCompletedError,
} from "./wsTransport.errors";
import { cappedExponentialRetryDelay } from "./wsTransport.retry";
import { WS_RECONNECT_INITIAL_DELAY_MS } from "./wsReconnectPolicy";
import { CONFIG_FALLBACK_DEADLINE_MS } from "./wsRpcClient.config";

type ServerStateClient = Pick<
  WsRpcClient["server"],
  "getConfig" | "subscribeConfig" | "subscribeLifecycle"
>;

interface ServerStateCallbacks {
  readonly getConfig: () => ServerConfig | null;
  readonly setSnapshot: (config: ServerConfig) => void;
  readonly applyEvent: (event: ServerConfigStreamEvent) => void;
  readonly emitWelcome: (payload: ServerLifecycleWelcomePayload) => void;
  readonly emitStalled?: (payload: ServerStalledPayload) => void;
}

const STABLE_STREAM_MS = 30_000;

function isSocketFailure(error: unknown): boolean {
  return Schema.is(RpcClientError)(error) && error.reason._tag.startsWith("Socket");
}

/** Synchronizes config with a bounded failure budget and value-free readiness diagnostics. */
export function startServerConfigSync(
  client: ServerStateClient,
  callbacks: ServerStateCallbacks,
): () => void {
  let disposed = false;
  let failures = 0;
  let firstAppliedAt: number | null = null;
  let attemptGeneration = 0;
  let fallbackPending = false;
  let subscriptionStopped = false;
  const generation = beginServerConfigReadiness(callbacks.getConfig() !== null);
  const isActive = () => !disposed && getServerConfigReadiness().generation === generation;
  const recordFailure = (failure: ConfigFailureCategory, exhausted: boolean) => {
    if (!isActive()) return;
    updateServerConfigReadiness(generation, {
      stream: exhausted ? "exhausted" : "retrying",
      failure,
      failureAt: new Date().toISOString(),
      failures,
      hasSnapshot: callbacks.getConfig() !== null,
    });
  };
  const subscribeConfig = () => {
    const attempt = ++attemptGeneration;
    let initialSnapshotApplied = false;
    const isCurrentAttempt = () => isActive() && attemptGeneration === attempt;
    return client.subscribeConfig(
      (event) => {
        if (!isCurrentAttempt()) return;
        const hadSnapshot = callbacks.getConfig() !== null;
        callbacks.applyEvent(event);
        const hasSnapshot = callbacks.getConfig() !== null;
        if (event.type === "snapshot" && hasSnapshot) initialSnapshotApplied = true;
        // Establishing the first applied baseline is progress; replaying it is not.
        if (!hadSnapshot && hasSnapshot) failures = 0;
        if (initialSnapshotApplied && firstAppliedAt === null) firstAppliedAt = Date.now();
        updateServerConfigReadiness(generation, {
          stream: initialSnapshotApplied ? "live" : "pending",
          hasSnapshot,
          failures,
          ...(hasSnapshot ? { failure: null } : {}),
        });
      },
      {
        initialApplication: {
          timeout: Duration.millis(CONFIG_FALLBACK_DEADLINE_MS),
          isApplied: () => isCurrentAttempt() && initialSnapshotApplied,
        },
        onResubscribe: () => {
          firstAppliedAt = null;
          initialSnapshotApplied = false;
        },
        shouldRetry: (error) => {
          if (!isCurrentAttempt()) return false;
          // A replayed snapshot is not recovery. Reset only after a sustained live attempt.
          if (firstAppliedAt !== null && Date.now() - firstAppliedAt >= STABLE_STREAM_MS) {
            failures = 0;
          }
          firstAppliedAt = null;
          failures += 1;
          const retry = failures < MAX_CONFIG_NO_PROGRESS_FAILURES;
          subscriptionStopped = !retry;
          recordFailure(
            Cause.isTimeoutError(error)
              ? "initial_snapshot_timeout"
              : error instanceof WsSubscriptionCompletedError
                ? "stream_completed"
                : isWsSubscriptionListenerFailure(error)
                  ? "application_failed"
                  : "subscription_failed",
            !retry,
          );
          return retry;
        },
        retryDelay: ({ error }) =>
          // Do not spend the whole config budget before the socket owner's first reconnect.
          cappedExponentialRetryDelay({
            attempt: failures,
            baseMs: isSocketFailure(error) ? WS_RECONNECT_INITIAL_DELAY_MS : 250,
            maxMs: 8_000,
          }),
        onError: (error) => {
          if (!isCurrentAttempt()) return;
          subscriptionStopped = true;
          // Unknown methods bypass shouldRetry, including after earlier retryable failures.
          if (getServerConfigReadiness().stream !== "exhausted") {
            if (failures === 0) failures = 1;
            const message =
              typeof error === "string" ? error : error instanceof Error ? error.message : "";
            recordFailure(
              message.includes("Unknown request tag:") ? "incompatible" : "subscription_failed",
              true,
            );
          }
        },
      },
    );
  };
  let stopConfig = subscribeConfig();
  const stopLifecycle = client.subscribeLifecycle((event) => {
    if (!isActive()) return;
    if (event.type === "welcome") callbacks.emitWelcome(event.payload);
    else if (event.type === "stalled") callbacks.emitStalled?.(event.payload);
  });

  const fetchFallback = () => {
    if (callbacks.getConfig() !== null || fallbackPending) return;
    fallbackPending = true;
    const attempt = attemptGeneration;
    updateServerConfigReadiness(generation, { fallback: "pending" });
    void client
      .getConfig()
      .then((config) => {
        if (!isActive() || attemptGeneration !== attempt) return;
        if (callbacks.getConfig() === null) callbacks.setSnapshot(config);
        updateServerConfigReadiness(generation, {
          fallback: "succeeded",
          hasSnapshot: true,
        });
      })
      .catch(() => {
        if (!isActive() || attemptGeneration !== attempt) return;
        updateServerConfigReadiness(generation, {
          fallback: "failed",
          ...(callbacks.getConfig() === null
            ? { failure: "fallback_failed", failureAt: new Date().toISOString() }
            : {}),
        });
      })
      .finally(() => {
        fallbackPending = false;
        if (isActive() && attemptGeneration !== attempt) fetchFallback();
      });
  };
  fetchFallback();
  const stopRetryOwner = registerServerConfigRetry(
    generation,
    () => {
      if (!isActive()) return;
      stopConfig();
      failures = 0;
      subscriptionStopped = false;
      firstAppliedAt = null;
      updateServerConfigReadiness(generation, { stream: "pending", failures: 0, failure: null });
      stopConfig = subscribeConfig();
      fetchFallback();
    },
    () => subscriptionStopped,
  );

  return () => {
    disposed = true;
    stopRetryOwner();
    stopConfig();
    stopLifecycle();
  };
}
