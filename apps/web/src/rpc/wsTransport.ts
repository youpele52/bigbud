import { Duration, Effect, Option, Stream } from "effect";

import { clearAllTrackedRpcRequests } from "./requestLatencyState";
import {
  cappedExponentialRetryDelay,
  resolveSubscriptionRetryDelayMs,
  type SubscriptionRetryDelay,
} from "./wsTransport.retry";
import { runWsStreamOnSession } from "./wsTransport.stream";
import { recordWsProtocolRecovery } from "./wsConnectionState";
import {
  closeWsTransportSession,
  createWsTransportSession,
  type TransportSession,
} from "./wsTransport.session";
import { waitForExplicitWsRecovery, waitForWsRetry } from "./wsTransport.wait";
import { scopedWsFiniteRequest, withWsRequestDeadline } from "./wsTransport.request";
import type { WsInitialApplicationDeadline } from "./wsTransport.initialValue";
import { type WsProtocolLifecycleHandlers, type WsRpcProtocolClient } from "./protocol";

interface SubscribeOptions {
  readonly initialApplication?: WsInitialApplicationDeadline;
  readonly retryDelay?: SubscriptionRetryDelay;
  readonly onError?: (error: unknown) => void;
  readonly onResubscribe?: () => void;
  readonly shouldRetry?: (error: unknown) => boolean;
}

interface RequestOptions {
  readonly timeout?: Option.Option<Duration.Input>;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);
const NOOP: () => void = () => undefined;
const SUBSCRIPTION_LISTENER_FAILURE_NAME = "WsSubscriptionListenerError";

export class WsSubscriptionCompletedError extends Error {
  constructor() {
    super("Persistent WebSocket subscription completed unexpectedly.");
    this.name = "WsSubscriptionCompletedError";
  }
}

export class WsProtocolRecoveryExhaustedError extends Error {
  constructor() {
    super("WebSocket RPC recovery exhausted. Retry explicitly to reconnect.");
    this.name = "WsProtocolRecoveryExhaustedError";
  }
}

class WsSubscriptionListenerError extends Error {
  readonly listenerCause: unknown;

  constructor(cause: unknown) {
    super(formatErrorMessage(cause));
    this.name = SUBSCRIPTION_LISTENER_FAILURE_NAME;
    this.listenerCause = cause;
  }
}

export function markWsSubscriptionListenerFailure(error: unknown): unknown {
  return isWsSubscriptionListenerFailure(error) ? error : new WsSubscriptionListenerError(error);
}

export function isWsSubscriptionListenerFailure(error: unknown): boolean {
  return error instanceof Error && error.name === SUBSCRIPTION_LISTENER_FAILURE_NAME;
}

function subscriptionErrorCause(error: unknown): unknown {
  return error instanceof WsSubscriptionListenerError ? error.listenerCause : error;
}

function formatErrorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return String(error);
}

function isUnknownRequestTagError(error: unknown): boolean {
  return formatErrorMessage(error).includes("Unknown request tag:");
}

export class WsTransport {
  private readonly lifecycleHandlers: WsProtocolLifecycleHandlers | undefined;
  private readonly url: string | undefined;
  private disposed = false;
  private hasReportedTransportDisconnect = false;
  private reconnectOperation: Promise<void> | null = null;
  private protocolFailures = 0;
  private protocolExhausted = false;
  private sessionCreatedAt = Date.now();
  private readonly disposalController = new AbortController();
  private readonly subscriptionControllers = new Set<AbortController>();
  private readonly recoveryWaiters = new Set<() => void>();
  private nextSessionId = 0;
  private activeSessionId = 0;
  private session: TransportSession;

  constructor(url?: string, lifecycleHandlers?: WsProtocolLifecycleHandlers) {
    this.lifecycleHandlers = lifecycleHandlers;
    this.url = url;
    this.session = this.createSession();
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    await this.reconnectOperation;
    if (this.protocolExhausted) throw new WsProtocolRecoveryExhaustedError();

    const session = this.session;
    return await session.runtime.runPromise(
      withWsRequestDeadline(
        Effect.promise(() => session.clientPromise).pipe(
          Effect.flatMap((client) => Effect.suspend(() => execute(client))),
        ),
        options?.timeout,
      ),
    );
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void | Promise<void>,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    await this.reconnectOperation;
    if (this.protocolExhausted) throw new WsProtocolRecoveryExhaustedError();

    const session = this.session;
    await session.runtime.runPromise(
      scopedWsFiniteRequest(
        session.clientPromise,
        connect,
        listener,
        () => !this.disposed && this.activeSessionId !== 0 && session === this.session,
      ),
    );
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void | Promise<void>,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    let hasReceivedValue = false;
    let retryAttempt = 0;
    let completionAttempt = 0;
    let cancelCurrentStream: () => void = NOOP;
    const controller = new AbortController();
    this.subscriptionControllers.add(controller);

    void (async () => {
      for (;;) {
        if (!active || this.disposed) {
          return;
        }
        await this.reconnectOperation;
        if (!active || this.disposed) return;
        if (this.protocolExhausted) {
          options?.onError?.(new WsProtocolRecoveryExhaustedError());
          await waitForExplicitWsRecovery(this.recoveryWaiters, controller.signal);
          continue;
        }

        const session = this.session;
        try {
          if (hasReceivedValue) {
            options?.onResubscribe?.();
          }

          const runningStream = runWsStreamOnSession(
            session,
            connect,
            listener,
            () =>
              active && !this.disposed && this.activeSessionId !== 0 && session === this.session,
            () => {
              hasReceivedValue = true;
            },
            () => {
              retryAttempt = 0;
              this.hasReportedTransportDisconnect = false;
              if (Date.now() - this.sessionCreatedAt >= 30_000) this.protocolFailures = 0;
            },
            markWsSubscriptionListenerFailure,
            options?.initialApplication,
          );
          cancelCurrentStream = runningStream.cancel;
          try {
            await runningStream.completed;
          } finally {
            // Release this attempt's request scope before scheduling its replacement.
            runningStream.cancel();
            cancelCurrentStream = NOOP;
          }
          if (!active || this.disposed) return;
          if (session !== this.session) continue;
          completionAttempt += 1;
          throw new WsSubscriptionCompletedError();
        } catch (error) {
          if (!active || this.disposed) {
            return;
          }
          if (session !== this.session || this.activeSessionId === 0) {
            await this.reconnectOperation;
            continue;
          }
          const listenerFailure = isWsSubscriptionListenerFailure(error);
          const reportedError = subscriptionErrorCause(error);
          if (!listenerFailure && isUnknownRequestTagError(error)) {
            options?.onError?.(reportedError);
            console.warn("WebSocket RPC subscription unavailable", {
              category: "unsupported_method",
            });
            return;
          }
          if (options?.shouldRetry?.(error) === false) {
            options?.onError?.(reportedError);
            console.warn("WebSocket RPC subscription unavailable", {
              category: listenerFailure ? "listener_failure" : "subscription_failure",
            });
            return;
          }

          if (!this.hasReportedTransportDisconnect) {
            console.warn("WebSocket RPC subscription disconnected", {
              category: listenerFailure ? "listener_failure" : "subscription_failure",
            });
          }
          this.hasReportedTransportDisconnect = true;
          retryAttempt += 1;
          if (!(error instanceof WsSubscriptionCompletedError)) completionAttempt = 0;
          const attempt = Math.max(retryAttempt, completionAttempt);
          const retryDelayMs = resolveSubscriptionRetryDelayMs(
            options?.retryDelay,
            { error, attempt },
            Duration.millis(
              cappedExponentialRetryDelay({
                attempt,
                baseMs: Duration.toMillis(DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS),
                maxMs: 8_000,
              }),
            ),
          );
          await waitForWsRetry(retryDelayMs, controller.signal);
        }

        if (session !== this.session) {
          continue;
        }
      }
    })()
      .catch((error: unknown) => {
        if (active && !this.disposed) options?.onError?.(error);
      })
      .finally(() => {
        this.subscriptionControllers.delete(controller);
      });

    return () => {
      active = false;
      controller.abort();
      cancelCurrentStream();
    };
  }

  async reconnect() {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    if (this.reconnectOperation) return this.reconnectOperation;
    this.protocolFailures = 0;
    this.protocolExhausted = false;
    const reconnectOperation = (async () => {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }

      clearAllTrackedRpcRequests();
      const previousSession = this.session;
      this.activeSessionId = 0;
      await this.closeSession(previousSession);
      if (!this.disposed) {
        this.session = this.createSession();
        for (const resume of this.recoveryWaiters) resume();
      }
    })();

    this.reconnectOperation = reconnectOperation;
    try {
      await reconnectOperation;
    } finally {
      if (this.reconnectOperation === reconnectOperation) this.reconnectOperation = null;
    }
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposalController.abort();
    for (const controller of this.subscriptionControllers) controller.abort();
    await this.closeSession(this.session);
  }

  private closeSession(session: TransportSession) {
    return closeWsTransportSession(session);
  }

  private createSession(): TransportSession {
    const sessionId = this.nextSessionId + 1;
    this.nextSessionId = sessionId;
    this.activeSessionId = sessionId;
    this.sessionCreatedAt = Date.now();
    return createWsTransportSession(this.url, {
      ...this.lifecycleHandlers,
      isActive: () => !this.disposed && this.activeSessionId === sessionId,
      onProtocolFailure: () => {
        this.retireProtocolSession(sessionId);
        this.lifecycleHandlers?.onProtocolFailure?.();
      },
    });
  }

  private retireProtocolSession(sessionId: number): void {
    if (this.disposed || this.activeSessionId !== sessionId || this.reconnectOperation) return;
    this.activeSessionId = 0;
    this.protocolFailures += 1;
    this.protocolExhausted = this.protocolFailures >= 3;
    recordWsProtocolRecovery(this.protocolExhausted);
    const previousSession = this.session;
    const operation = (async () => {
      await this.closeSession(previousSession);
      if (this.protocolExhausted || this.disposed) return;
      await waitForWsRetry(
        cappedExponentialRetryDelay({
          attempt: this.protocolFailures,
          baseMs: 250,
          maxMs: 8_000,
        }),
        this.disposalController.signal,
      );
      if (!this.disposed) this.session = this.createSession();
    })();
    this.reconnectOperation = operation;
    void operation
      .finally(() => {
        if (this.reconnectOperation === operation) this.reconnectOperation = null;
      })
      .catch(() => {
        this.protocolExhausted = true;
        recordWsProtocolRecovery(true);
      });
  }
}
