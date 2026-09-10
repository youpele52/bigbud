import type { MobileWsProtocolLifecycleHandlers } from "../lib/mobileRpc.protocol";

export type MobileTransportEvidence =
  | "unpaired"
  | "connecting"
  | "open"
  | "retrying"
  | "exhausted"
  | "closed";

export type MobileAuthorizationEvidence = "unknown" | "locally-expired" | "explicitly-rejected";

export interface MobileConnectionState {
  readonly generation: number;
  readonly transport: MobileTransportEvidence;
  readonly authorization: MobileAuthorizationEvidence;
  readonly attempt: number;
  readonly retryCount: number | null;
  readonly retryDelayMs: number | null;
  readonly lastError: string | null;
  readonly expiresAt: string | null;
  readonly expired: boolean;
}

export interface MobileConnectionLease {
  readonly generation: number;
  readonly handlers: MobileWsProtocolLifecycleHandlers;
  readonly isActive: () => boolean;
  readonly expire: () => void;
  readonly dispose: () => void;
}

export interface MobileConnectionLifecycle {
  readonly begin: (expiresAt: string) => MobileConnectionLease;
  readonly reset: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => MobileConnectionState;
}

type MobileConnectionTimer = ReturnType<typeof globalThis.setTimeout>;

export interface MobileConnectionScheduler {
  readonly setTimeout: (callback: () => void, delayMs: number) => MobileConnectionTimer;
  readonly clearTimeout: (timerId: MobileConnectionTimer) => void;
}

export function initialMobileConnectionState(): MobileConnectionState {
  return {
    generation: 0,
    transport: "unpaired",
    authorization: "unknown",
    attempt: 0,
    retryCount: null,
    retryDelayMs: null,
    lastError: null,
    expiresAt: null,
    expired: false,
  };
}

export function isExplicitMobileAuthorizationClose(details: {
  readonly code: number;
  readonly reason: string;
}): boolean {
  if (![1008, 4001, 4401, 4403].includes(details.code)) return false;
  return /auth|forbidden|expired|revoked|unauthori[sz]ed|rejected/i.test(details.reason);
}

export function scheduleMobileConnectionExpiry(input: {
  readonly expiresAt: string;
  readonly now?: () => number;
  readonly scheduler?: MobileConnectionScheduler;
  readonly onExpired: () => void;
}): () => void {
  const expiresAtMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return () => undefined;
  const scheduler =
    input.scheduler ??
    ({
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timerId) => globalThis.clearTimeout(timerId),
    } satisfies MobileConnectionScheduler);
  const timerId = scheduler.setTimeout(
    input.onExpired,
    Math.max(0, expiresAtMs - (input.now ?? Date.now)()),
  );
  return () => scheduler.clearTimeout(timerId);
}

function formatError(message: string): string | null {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createMobileConnectionLifecycle(): MobileConnectionLifecycle {
  const listeners = new Set<() => void>();
  let state = initialMobileConnectionState();
  let generation = 0;

  const publish = (next: Partial<MobileConnectionState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const reset = () => {
    generation += 1;
    publish({ ...initialMobileConnectionState(), generation });
  };

  const begin = (expiresAt: string): MobileConnectionLease => {
    generation += 1;
    const leaseGeneration = generation;
    let disposed = false;
    publish({
      ...initialMobileConnectionState(),
      generation: leaseGeneration,
      transport: "connecting",
      expiresAt,
    });

    const isCurrent = () => !disposed && state.generation === leaseGeneration;
    const update = (next: Partial<MobileConnectionState>) => {
      if (isCurrent()) publish(next);
    };
    const expire = () => {
      if (!isCurrent()) return;
      disposed = true;
      publish({
        transport: "closed",
        authorization: "locally-expired",
        expired: true,
        lastError: null,
        retryCount: null,
        retryDelayMs: null,
      });
    };
    const handlers: MobileWsProtocolLifecycleHandlers = {
      onAttempt: () => {
        update({
          transport: "connecting",
          attempt: state.attempt + 1,
          retryCount: null,
          retryDelayMs: null,
        });
      },
      onRetry: ({ retryCount, delayMs }) => {
        update({ transport: "retrying", retryCount, retryDelayMs: delayMs });
      },
      onOpen: () => {
        update({
          transport: "open",
          attempt: 0,
          retryCount: null,
          retryDelayMs: null,
          lastError: null,
        });
      },
      onError: (message) => {
        update({
          transport: state.transport === "open" ? "closed" : state.transport,
          lastError: formatError(message),
        });
      },
      onClose: (details) => {
        update({
          transport: "closed",
          authorization: isExplicitMobileAuthorizationClose(details)
            ? "explicitly-rejected"
            : state.authorization,
          lastError: details.reason.trim() || state.lastError,
        });
      },
      onExhausted: () => {
        update({ transport: "exhausted", retryCount: null, retryDelayMs: null });
      },
    };

    return {
      generation: leaseGeneration,
      handlers,
      isActive: () => isCurrent(),
      expire,
      dispose: () => {
        disposed = true;
      },
    };
  };

  return {
    begin,
    reset,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
  } satisfies MobileConnectionLifecycle;
}
