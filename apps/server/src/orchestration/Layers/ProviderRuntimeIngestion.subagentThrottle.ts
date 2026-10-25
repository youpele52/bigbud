/**
 * Synchronous per-task throttle for provider-subagent upserts.
 *
 * Ingestion processes each thread's events sequentially, so this throttle keeps no timers:
 * suppressed snapshots are flushed opportunistically when the thread's next runtime event
 * arrives after the window, and unconditionally at turn, session, stop and shutdown boundaries.
 * The first update, any status/kind/model change and every terminal status persist immediately.
 *
 * @module ProviderRuntimeIngestion.subagentThrottle
 */
import type { OrchestrationTask } from "@bigbud/contracts";

export const SUBAGENT_THROTTLE_WINDOW_MS = 1_000;
export const SUBAGENT_THROTTLE_MAX_TASKS_PER_THREAD = 256;
export const SUBAGENT_THROTTLE_MAX_THREADS = 256;

export interface PendingSubagentUpsert {
  readonly threadId: string;
  readonly task: OrchestrationTask;
}

export interface SubagentThrottleDecision {
  readonly persist: boolean;
  /** Pending snapshots evicted by the capacity bound. Callers persist these first. */
  readonly evicted: ReadonlyArray<PendingSubagentUpsert>;
}

interface Entry {
  lastPersistedAt: number;
  pending: OrchestrationTask | undefined;
}

const isTerminal = (status: OrchestrationTask["status"]) =>
  status === "completed" || status === "failed" || status === "stopped";

export class SubagentUpsertThrottle {
  private readonly threads = new Map<string, Map<string, Entry>>();
  private readonly windowMs: number;
  private readonly maxTasksPerThread: number;
  private readonly maxThreads: number;

  constructor(options?: {
    readonly windowMs?: number;
    readonly maxTasksPerThread?: number;
    readonly maxThreads?: number;
  }) {
    this.windowMs = options?.windowMs ?? SUBAGENT_THROTTLE_WINDOW_MS;
    this.maxTasksPerThread = options?.maxTasksPerThread ?? SUBAGENT_THROTTLE_MAX_TASKS_PER_THREAD;
    this.maxThreads = options?.maxThreads ?? SUBAGENT_THROTTLE_MAX_THREADS;
  }

  /** The latest suppressed snapshot, used as the merge base for the next update. */
  pending(threadId: string, taskId: string): OrchestrationTask | undefined {
    return this.threads.get(threadId)?.get(taskId)?.pending;
  }

  decide(input: {
    readonly threadId: string;
    readonly task: OrchestrationTask;
    readonly previous: OrchestrationTask | undefined;
    readonly nowMs: number;
  }): SubagentThrottleDecision {
    const { threadId, task, previous, nowMs } = input;
    if (task.kind !== "providerSubagent") return { persist: true, evicted: [] };
    if (isTerminal(task.status)) {
      this.forget(threadId, task.id);
      return { persist: true, evicted: [] };
    }
    const evicted: PendingSubagentUpsert[] = [];
    const tasks = this.touchThread(threadId, evicted);
    const entry = tasks.get(task.id);
    const immediate =
      previous === undefined ||
      previous.status !== task.status ||
      previous.kind !== task.kind ||
      previous.model !== task.model ||
      entry === undefined ||
      nowMs - entry.lastPersistedAt >= this.windowMs;
    if (entry) tasks.delete(task.id);
    else this.evictTaskIfFull(threadId, tasks, evicted);
    tasks.set(task.id, {
      lastPersistedAt: immediate ? nowMs : entry!.lastPersistedAt,
      pending: immediate ? undefined : task,
    });
    return { persist: immediate, evicted };
  }

  /** Pending snapshots whose window has elapsed; they count as persisted at `nowMs`. */
  takeDue(threadId: string, nowMs: number): ReadonlyArray<OrchestrationTask> {
    const tasks = this.threads.get(threadId);
    if (!tasks) return [];
    const due: OrchestrationTask[] = [];
    for (const entry of tasks.values()) {
      if (entry.pending && nowMs - entry.lastPersistedAt >= this.windowMs) {
        due.push(entry.pending);
        entry.pending = undefined;
        entry.lastPersistedAt = nowMs;
      }
    }
    return due;
  }

  /** Every pending snapshot for a thread, for turn/session/stop boundaries. */
  takeAll(threadId: string): ReadonlyArray<OrchestrationTask> {
    const tasks = this.threads.get(threadId);
    if (!tasks) return [];
    const all: OrchestrationTask[] = [];
    for (const entry of tasks.values()) {
      if (entry.pending) all.push(entry.pending);
      entry.pending = undefined;
    }
    return all;
  }

  /** Every pending snapshot across threads, for ingestion shutdown. */
  takeEverything(): ReadonlyArray<PendingSubagentUpsert> {
    const all: PendingSubagentUpsert[] = [];
    for (const threadId of this.threads.keys()) {
      for (const task of this.takeAll(threadId)) all.push({ threadId, task });
    }
    return all;
  }

  discard(threadId: string, taskId: string): void {
    this.forget(threadId, taskId);
  }

  private forget(threadId: string, taskId: string): void {
    const tasks = this.threads.get(threadId);
    if (!tasks) return;
    tasks.delete(taskId);
    if (tasks.size === 0) this.threads.delete(threadId);
  }

  private touchThread(threadId: string, evicted: PendingSubagentUpsert[]): Map<string, Entry> {
    const existing = this.threads.get(threadId);
    if (existing) {
      this.threads.delete(threadId);
      this.threads.set(threadId, existing);
      return existing;
    }
    if (this.threads.size >= this.maxThreads) {
      const oldest = this.threads.keys().next().value;
      if (oldest !== undefined) {
        for (const task of this.takeAll(oldest)) evicted.push({ threadId: oldest, task });
        this.threads.delete(oldest);
      }
    }
    const created = new Map<string, Entry>();
    this.threads.set(threadId, created);
    return created;
  }

  private evictTaskIfFull(
    threadId: string,
    tasks: Map<string, Entry>,
    evicted: PendingSubagentUpsert[],
  ): void {
    if (tasks.size < this.maxTasksPerThread) return;
    const oldest = tasks.keys().next();
    if (oldest.done) return;
    const entry = tasks.get(oldest.value);
    if (entry?.pending) evicted.push({ threadId, task: entry.pending });
    tasks.delete(oldest.value);
  }
}
