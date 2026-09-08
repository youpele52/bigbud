export const REMOTE_AGENT_UPDATE_INTERVAL_MS = 15 * 60 * 1_000;
export const REMOTE_AGENT_UPDATE_MAX_CONCURRENCY = 2;
export const REMOTE_AGENT_UPDATE_JITTER_RATIO = 0.1;

export type RemoteAgentUpdateTrigger =
  | "startup"
  | "authenticated"
  | "source-changed"
  | "slot-reclaimable"
  | "scheduled"
  | "explicit-retry";

export interface RemoteAgentUpdateScheduleItem {
  readonly triggers: ReadonlySet<RemoteAgentUpdateTrigger>;
  readonly forceRetry: boolean;
}

export interface RemoteAgentUpdateScheduler {
  readonly start: () => void;
  readonly stop: () => void;
  readonly enqueue: (target: string, trigger: RemoteAgentUpdateTrigger) => void;
  readonly refreshNow: () => Promise<void>;
  readonly tick: () => Promise<void>;
  readonly drain: () => Promise<void>;
}

interface SchedulerDependencies {
  readonly discoverTargets: () => Promise<ReadonlyArray<string>>;
  readonly refreshSource: () => Promise<unknown>;
  readonly check: (target: string, item: RemoteAgentUpdateScheduleItem) => Promise<void>;
  readonly onError?: (cause: unknown, target?: string) => void;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly intervalMs?: number;
  readonly jitterRatio?: number;
  readonly maxConcurrency?: number;
}

function mergeScheduleItem(
  current: RemoteAgentUpdateScheduleItem | undefined,
  trigger: RemoteAgentUpdateTrigger,
): RemoteAgentUpdateScheduleItem {
  return {
    triggers: new Set([...(current?.triggers ?? []), trigger]),
    forceRetry: current?.forceRetry === true || trigger === "explicit-retry",
  };
}

function jitteredDelay(input: {
  readonly intervalMs: number;
  readonly jitterRatio: number;
  readonly random: () => number;
}): number {
  const random = Math.min(1, Math.max(0, input.random()));
  const jitter = input.intervalMs * Math.max(0, input.jitterRatio);
  return Math.max(0, Math.round(input.intervalMs - jitter + random * jitter * 2));
}

/**
 * A process-local coalescing scheduler. Durable request identity and slot
 * ownership live in the remote registry; this only bounds discovery work.
 */
export function makeRemoteAgentUpdateScheduler(
  dependencies: SchedulerDependencies,
): RemoteAgentUpdateScheduler {
  const pending = new Map<string, RemoteAgentUpdateScheduleItem>();
  const active = new Set<string>();
  const activeUpdates = new Map<string, RemoteAgentUpdateScheduleItem>();
  const waiters = new Set<() => void>();
  const intervalMs = dependencies.intervalMs ?? REMOTE_AGENT_UPDATE_INTERVAL_MS;
  const jitterRatio = dependencies.jitterRatio ?? REMOTE_AGENT_UPDATE_JITTER_RATIO;
  const maxConcurrency = Math.max(
    1,
    Math.min(REMOTE_AGENT_UPDATE_MAX_CONCURRENCY, dependencies.maxConcurrency ?? 2),
  );
  const random = dependencies.random ?? Math.random;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let tickInFlight: Promise<void> | undefined;
  let discoveryInFlight: Promise<void> | undefined;

  const notifyIdle = () => {
    if (pending.size !== 0 || active.size !== 0 || activeUpdates.size !== 0 || tickInFlight) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  const pump = () => {
    while (active.size < maxConcurrency && pending.size > 0) {
      const next = pending.entries().next().value as
        | [string, RemoteAgentUpdateScheduleItem]
        | undefined;
      if (!next) break;
      const [target, item] = next;
      pending.delete(target);
      active.add(target);
      void dependencies
        .check(target, item)
        .catch((cause: unknown) => dependencies.onError?.(cause, target))
        .finally(() => {
          active.delete(target);
          const next = activeUpdates.get(target);
          if (next) {
            activeUpdates.delete(target);
            const nextPending = new Map([[target, next], ...pending.entries()]);
            pending.clear();
            for (const [queuedTarget, queuedItem] of nextPending) {
              pending.set(queuedTarget, queuedItem);
            }
          }
          pump();
          notifyIdle();
        });
    }
  };

  const enqueue = (target: string, trigger: RemoteAgentUpdateTrigger) => {
    if (!target) return;
    if (active.has(target)) {
      activeUpdates.set(target, mergeScheduleItem(activeUpdates.get(target), trigger));
    } else {
      pending.set(target, mergeScheduleItem(pending.get(target), trigger));
    }
    pump();
  };

  const discover = async (trigger: RemoteAgentUpdateTrigger): Promise<void> => {
    await dependencies.refreshSource();
    const targets = await dependencies.discoverTargets();
    for (const target of new Set(targets)) enqueue(target, trigger);
    pump();
  };

  const discoverOnce = (trigger: RemoteAgentUpdateTrigger): Promise<void> => {
    if (discoveryInFlight) return discoveryInFlight;
    const current = discover(trigger);
    let shared!: Promise<void>;
    shared = current.finally(() => {
      if (discoveryInFlight === shared) discoveryInFlight = undefined;
    });
    discoveryInFlight = shared;
    return shared;
  };

  const tick = async (): Promise<void> => {
    if (tickInFlight) return tickInFlight;
    tickInFlight = discoverOnce("scheduled").catch((cause: unknown) => {
      dependencies.onError?.(cause);
    });
    try {
      await tickInFlight;
    } finally {
      tickInFlight = undefined;
      notifyIdle();
    }
  };

  const scheduleNext = () => {
    if (!started) return;
    timer = setTimer(() => {
      timer = undefined;
      void tick().finally(scheduleNext);
    }, jitteredDelay({ intervalMs, jitterRatio, random }));
  };

  const refreshNow = async () => {
    await discoverOnce("source-changed");
  };

  return {
    start: () => {
      if (started) return;
      started = true;
      void tick().finally(scheduleNext);
    },
    stop: () => {
      started = false;
      if (timer) clearTimer(timer);
      timer = undefined;
      pending.clear();
      activeUpdates.clear();
      notifyIdle();
    },
    enqueue,
    refreshNow,
    tick,
    drain: () => {
      if (pending.size === 0 && active.size === 0 && activeUpdates.size === 0 && !tickInFlight)
        return Promise.resolve();
      return new Promise<void>((resolve) => waiters.add(resolve));
    },
  } satisfies RemoteAgentUpdateScheduler;
}
