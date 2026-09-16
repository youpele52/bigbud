import type { MobileWsProtocolLifecycleHandlers } from "../lib/mobileRpc.protocol";

export type MobileTransportEvidence =
  | "unpaired"
  | "connecting"
  | "open"
  | "retrying"
  | "exhausted"
  | "closed";

export type MobileIncidentLevel = "none" | "short" | "reconnecting" | "escalated";

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
  readonly browserOffline: boolean;
  readonly incidentStartedAt: number | null;
  readonly incidentLevel: MobileIncidentLevel;
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
  readonly setBrowserOffline: (offline: boolean) => void;
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
    browserOffline: false,
    incidentStartedAt: null,
    incidentLevel: "none",
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

export function createMobileConnectionLifecycle(options?: {
  readonly now?: () => number;
  readonly scheduler?: MobileConnectionScheduler;
}): MobileConnectionLifecycle {
  const listeners = new Set<() => void>();
  let state = initialMobileConnectionState();
  let generation = 0;
  let browserOffline = false;
  let incidentTimer: MobileConnectionTimer | null = null;
  const now = options?.now ?? Date.now;
  const scheduler =
    options?.scheduler ??
    ({
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timerId) => globalThis.clearTimeout(timerId),
    } satisfies MobileConnectionScheduler);

  const clearIncidentTimer = () => {
    if (incidentTimer === null) return;
    scheduler.clearTimeout(incidentTimer);
    incidentTimer = null;
  };

  const publish = (next: Partial<MobileConnectionState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const reset = () => {
    clearIncidentTimer();
    generation += 1;
    publish({ ...initialMobileConnectionState(), browserOffline, generation });
  };

  const setBrowserOffline = (offline: boolean) => {
    browserOffline = offline;
    publish({ browserOffline: offline });
  };

  const begin = (expiresAt: string): MobileConnectionLease => {
    clearIncidentTimer();
    generation += 1;
    const leaseGeneration = generation;
    let disposed = false;
    const incidentStartedAt = now();
    let activeIncidentStartedAt: number | null = incidentStartedAt;
    publish({
      ...initialMobileConnectionState(),
      browserOffline,
      generation: leaseGeneration,
      transport: "connecting",
      expiresAt,
      incidentStartedAt,
      incidentLevel: "short",
    });

    const scheduleIncidentThreshold = (level: Exclude<MobileIncidentLevel, "none" | "short">) => {
      clearIncidentTimer();
      const thresholdMs = level === "reconnecting" ? 2_000 : 10_000;
      const elapsedMs = Math.max(0, now() - (activeIncidentStartedAt ?? now()));
      incidentTimer = scheduler.setTimeout(
        () => {
          incidentTimer = null;
          if (!isCurrent()) return;
          publish({ incidentLevel: level });
          if (level === "reconnecting") scheduleIncidentThreshold("escalated");
        },
        Math.max(0, thresholdMs - elapsedMs),
      );
    };

    const startIncident = () => {
      if (!isCurrent()) return;
      if (activeIncidentStartedAt === null) activeIncidentStartedAt = now();
      if (state.incidentStartedAt !== activeIncidentStartedAt)
        publish({ incidentStartedAt: activeIncidentStartedAt, incidentLevel: "short" });
      if (state.incidentLevel === "none") {
        publish({ incidentLevel: "short" });
      }
      scheduleIncidentThreshold("reconnecting");
    };

    const isCurrent = () => !disposed && state.generation === leaseGeneration;
    scheduleIncidentThreshold("reconnecting");

    const update = (next: Partial<MobileConnectionState>) => {
      if (isCurrent()) publish(next);
    };
    const expire = () => {
      if (!isCurrent()) return;
      disposed = true;
      clearIncidentTimer();
      publish({
        transport: "closed",
        authorization: "locally-expired",
        expired: true,
        lastError: null,
        retryCount: null,
        retryDelayMs: null,
        incidentLevel: "none",
      });
    };
    const handlers: MobileWsProtocolLifecycleHandlers = {
      onAttempt: () => {
        startIncident();
        update({
          transport: "connecting",
          attempt: state.attempt + 1,
          retryCount: null,
          retryDelayMs: null,
        });
      },
      onRetry: ({ retryCount, delayMs }) => {
        startIncident();
        update({ transport: "retrying", retryCount, retryDelayMs: delayMs });
      },
      onOpen: () => {
        clearIncidentTimer();
        update({
          transport: "open",
          attempt: 0,
          retryCount: null,
          retryDelayMs: null,
          lastError: null,
          incidentStartedAt: null,
          incidentLevel: "none",
        });
        activeIncidentStartedAt = null;
      },
      onError: (message) => {
        if (state.transport === "open") startIncident();
        update({
          transport: state.transport === "open" ? "closed" : state.transport,
          lastError: formatError(message),
        });
      },
      onClose: (details) => {
        startIncident();
        update({
          transport: "closed",
          authorization: isExplicitMobileAuthorizationClose(details)
            ? "explicitly-rejected"
            : state.authorization,
          lastError: details.reason.trim() || state.lastError,
        });
      },
      onExhausted: () => {
        clearIncidentTimer();
        update({
          transport: "exhausted",
          retryCount: null,
          retryDelayMs: null,
          incidentLevel: "escalated",
        });
      },
    };

    return {
      generation: leaseGeneration,
      handlers,
      isActive: () => isCurrent(),
      expire,
      dispose: () => {
        disposed = true;
        clearIncidentTimer();
      },
    };
  };

  return {
    begin,
    reset,
    setBrowserOffline,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
  } satisfies MobileConnectionLifecycle;
}
