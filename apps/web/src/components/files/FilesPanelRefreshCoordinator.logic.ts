export const FILES_PANEL_REFRESH_DEBOUNCE_MS = 150;
export const FILES_PANEL_REFRESH_MAX_WAIT_MS = 500;

export interface FilesPanelRefreshTask {
  readonly key: string;
  readonly priority: number;
  readonly run: () => void | Promise<void>;
}

interface QueuedTask extends FilesPanelRefreshTask {
  readonly queuedAt: number;
  readonly sequence: number;
}

export interface FilesPanelRefreshCoordinatorOptions {
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly now?: () => number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

export interface FilesPanelRefreshCoordinator {
  readonly schedule: (task: FilesPanelRefreshTask) => void;
  readonly scheduleAll: (tasks: ReadonlyArray<FilesPanelRefreshTask>) => void;
  readonly cancel: (key: string) => void;
  readonly cancelAll: () => void;
  readonly dispose: () => void;
}

function taskOrder(left: QueuedTask, right: QueuedTask): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  return left.sequence - right.sequence;
}

export function createFilesPanelRefreshCoordinator(
  options: FilesPanelRefreshCoordinatorOptions = {},
): FilesPanelRefreshCoordinator {
  const debounceMs = Math.max(0, Math.floor(options.debounceMs ?? FILES_PANEL_REFRESH_DEBOUNCE_MS));
  const maxWaitMs = Math.max(
    debounceMs,
    Math.floor(options.maxWaitMs ?? FILES_PANEL_REFRESH_MAX_WAIT_MS),
  );
  const now = options.now ?? Date.now;
  const scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
  const clearScheduledTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  const queued = new Map<string, QueuedTask>();
  let sequence = 0;
  let debounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let disposed = false;
  let running = false;
  let queuedAt: number | null = null;

  const clearTimers = () => {
    if (debounceTimer !== null) {
      clearScheduledTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearScheduledTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  };

  const clearQueue = () => {
    queued.clear();
    queuedAt = null;
    clearTimers();
  };

  const takeNext = (): QueuedTask | undefined => {
    const candidates = [...queued.values()];
    if (candidates.length === 0) return undefined;
    const currentTime = now();
    const aged = candidates.filter((task) => currentTime - task.queuedAt >= maxWaitMs);
    const next = [...(aged.length > 0 ? aged : candidates)].toSorted(
      aged.length > 0
        ? (left, right) => left.queuedAt - right.queuedAt || left.sequence - right.sequence
        : taskOrder,
    )[0];
    if (next) queued.delete(next.key);
    return next;
  };

  const drain = async (): Promise<void> => {
    if (running || disposed) return;
    running = true;
    clearTimers();
    try {
      while (true) {
        if (disposed) break;
        const task = takeNext();
        if (!task) break;
        await task.run();
      }
    } finally {
      running = false;
      if (queued.size === 0) {
        queuedAt = null;
        clearTimers();
      } else if (!disposed) {
        void drain();
      }
    }
  };

  const flush = () => {
    clearTimers();
    void drain();
  };

  const schedule = (task: FilesPanelRefreshTask) => {
    if (disposed) return;
    const firstQueued = queued.size === 0;
    const timestamp = queuedAt ?? now();
    queued.set(task.key, { ...task, queuedAt: timestamp, sequence: sequence++ });
    if (firstQueued) {
      queuedAt = timestamp;
      if (!running) {
        debounceTimer = scheduleTimeout(flush, debounceMs);
        maxWaitTimer = scheduleTimeout(flush, maxWaitMs);
      }
    }
  };

  const cancel = (key: string) => {
    if (disposed) return;
    queued.delete(key);
    if (queued.size === 0 && !running) {
      queuedAt = null;
      clearTimers();
    }
  };

  return {
    schedule,
    scheduleAll: (tasks) => tasks.forEach(schedule),
    cancel,
    cancelAll: clearQueue,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearQueue();
    },
  };
}
