import { Duration, Effect, Option, Stream } from "effect";

import { clearAllTrackedRpcRequests } from "./requestLatencyState";
import {
  cappedExponentialRetryDelay,
  resolveSubscriptionRetryDelayMs,
  type SubscriptionRetryDelay,
} from "./wsTransport.retry";
import { runWsStreamOnSession } from "./wsTransport.stream";
import { recordWsProtocolRecovery, recordWsReconnectScheduled } from "./wsConnectionState";
import {
  closeWsTransportSession,
  createWsTransportSession,
  type TransportSession,
} from "./wsTransport.session";
import { waitForWsRetry } from "./wsTransport.wait";
import { scopedWsFiniteRequest, withWsRequestDeadline } from "./wsTransport.request";
import type { WsInitialApplicationDeadline } from "./wsTransport.initialValue";
import {
  createWsConnectionControls,
  type WsConnectionControls,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolClient,
} from "./protocol";
import {
  isUnknownRequestTagError,
  isWsSubscriptionListenerFailure,
  markWsSubscriptionListenerFailure,
  WsSubscriptionCompletedError,
  WsTransportDisconnectedError,
  wsSubscriptionErrorCause,
} from "./wsTransport.errors";
import {
  resolveWsProtocolRecoveryDelayMs,
  WS_PROTOCOL_FAILURE_ESCALATION,
  WsProtocolFailureWindow,
} from "./wsTransport.protocolWindow";

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

/** `down` means the socket closed and the transport is waiting to retry. */
type WsLinkState = "connecting" | "open" | "down";

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);
const NOOP: () => void = () => undefined;

export class WsTransport {
  private readonly lifecycleHandlers: WsProtocolLifecycleHandlers | undefined;
  private readonly url: string | undefined;
  private disposed = false;
  private hasReportedTransportDisconnect = false;
  private reconnectOperation: Promise<void> | null = null;
  private retiring = false;
  private hasOpened = false;
  private link: WsLinkState = "connecting";
  private readonly protocolFailures = new WsProtocolFailureWindow();
  private readonly controls: WsConnectionControls;
  private readonly disposalController = new AbortController();
  private readonly subscriptionControllers = new Set<AbortController>();
  private nextSessionId = 0;
  private activeSessionId = 0;
  private session: TransportSession;

  constructor(
    url?: string,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
    controls: WsConnectionControls = createWsConnectionControls(),
  ) {
    this.lifecycleHandlers = lifecycleHandlers;
    this.url = url;
    this.controls = controls;
    this.session = this.createSession();
  }

  /** True after a live socket dropped and no replacement attempt is in flight yet. */
  get isDisconnected(): boolean {
    return !this.disposed && this.hasOpened && (this.retiring || this.link === "down");
  }

  /** Fails fast while disconnected; the first connection still waits as before. */
  private assertConnectedOrConnecting(): void {
    if (this.isDisconnected) throw new WsTransportDisconnectedError();
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    this.assertConnectedOrConnecting();
    await this.reconnectOperation;
    this.assertConnectedOrConnecting();

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

    this.assertConnectedOrConnecting();
    await this.reconnectOperation;
    this.assertConnectedOrConnecting();

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
        // Subscriptions keep waiting on the live reconnect operation; they never give up.
        await this.reconnectOperation;
        if (!active || this.disposed) return;

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
          const reportedError = wsSubscriptionErrorCause(error);
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

    if (this.reconnectOperation) {
      // An explicit reconnect skips a pending protocol-recovery backoff.
      if (this.retiring) this.controls.backoff.wake();
      return this.reconnectOperation;
    }
    this.protocolFailures.reset();
    this.controls.backoff.reset();
    const reconnectOperation = (async () => {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }

      clearAllTrackedRpcRequests();
      const previousSession = this.session;
      this.activeSessionId = 0;
      await this.closeSession(previousSession);
      if (!this.disposed) this.session = this.createSession();
    })();

    this.reconnectOperation = reconnectOperation;
    try {
      await reconnectOperation;
    } finally {
      if (this.reconnectOperation === reconnectOperation) this.reconnectOperation = null;
    }
  }

  /**
   * Skips the current backoff wait without tearing down the session. Does nothing while the
   * socket is open or an attempt is already in flight, so wake signals cannot stack upgrades.
   */
  reconnectNow(): boolean {
    if (this.disposed) return false;
    if (!this.retiring && this.link !== "down") return false;
    this.controls.backoff.wake();
    return true;
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
    this.link = "connecting";
    const handlers = this.lifecycleHandlers;
    const isCurrent = () => !this.disposed && this.activeSessionId === sessionId;
    return createWsTransportSession(
      this.url,
      {
        ...handlers,
        isActive: isCurrent,
        onAttempt: (socketUrl) => {
          this.link = "connecting";
          handlers?.onAttempt?.(socketUrl);
        },
        onOpen: (details) => {
          this.link = "open";
          this.hasOpened = true;
          handlers?.onOpen?.(details);
        },
        onError: (message) => {
          this.link = "down";
          handlers?.onError?.(message);
        },
        onClose: (details) => {
          this.link = "down";
          handlers?.onClose?.(details);
        },
        onProtocolFailure: () => {
          this.retireProtocolSession(sessionId);
          handlers?.onProtocolFailure?.();
        },
      },
      this.controls,
    );
  }

  /** Protocol defects back off harder inside a sliding 30 s window, but never stop. */
  private retireProtocolSession(sessionId: number): void {
    if (this.disposed || this.activeSessionId !== sessionId || this.reconnectOperation) return;
    this.activeSessionId = 0;
    this.retiring = true;
    this.link = "down";
    const failuresInWindow = this.protocolFailures.record();
    const delayMs = resolveWsProtocolRecoveryDelayMs(failuresInWindow);
    if (failuresInWindow >= WS_PROTOCOL_FAILURE_ESCALATION) {
      console.warn("WebSocket RPC protocol failures repeated; backing off before recovery.", {
        delayMs,
        failuresInWindow,
      });
    }
    recordWsProtocolRecovery();
    recordWsReconnectScheduled(delayMs);
    const previousSession = this.session;
    const operation = (async () => {
      await this.closeSession(previousSession).catch(() => undefined);
      if (this.disposed) return;
      await this.controls.backoff.sleep(delayMs, this.disposalController.signal);
      if (!this.disposed) this.session = this.createSession();
    })();
    this.reconnectOperation = operation;
    void operation.finally(() => {
      if (this.reconnectOperation === operation) this.reconnectOperation = null;
      this.retiring = false;
    });
  }
}
