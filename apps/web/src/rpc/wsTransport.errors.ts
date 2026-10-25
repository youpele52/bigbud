import { APP_SERVER_NAME } from "../config/branding";

const SUBSCRIPTION_LISTENER_FAILURE_NAME = "WsSubscriptionListenerError";

export class WsSubscriptionCompletedError extends Error {
  constructor() {
    super("Persistent WebSocket subscription completed unexpectedly.");
    this.name = "WsSubscriptionCompletedError";
  }
}

/**
 * Raised immediately for a request made while the socket is down and waiting to retry.
 * Reconnects continue in the background; callers may retry once the transport is back.
 */
export class WsTransportDisconnectedError extends Error {
  readonly _tag = "WsTransportDisconnectedError";

  constructor() {
    super(`Not connected to the ${APP_SERVER_NAME}. Reconnecting in the background.`);
    this.name = "WsTransportDisconnectedError";
  }
}

/**
 * A request refused because the socket was down is a transport drop, not an application
 * failure: delivery resumes from the persisted cursor once the subscription is back.
 */
export function isWsTransportDisconnectedError(error: unknown): boolean {
  return (
    error instanceof WsTransportDisconnectedError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { readonly _tag?: unknown })._tag === "WsTransportDisconnectedError")
  );
}

class WsSubscriptionListenerError extends Error {
  readonly listenerCause: unknown;

  constructor(cause: unknown) {
    super(formatWsErrorMessage(cause));
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

export function wsSubscriptionErrorCause(error: unknown): unknown {
  return error instanceof WsSubscriptionListenerError ? error.listenerCause : error;
}

export function formatWsErrorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return String(error);
}

export function isUnknownRequestTagError(error: unknown): boolean {
  return formatWsErrorMessage(error).includes("Unknown request tag:");
}
