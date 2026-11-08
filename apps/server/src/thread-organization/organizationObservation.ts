import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

/** Minimum spacing between refreshes of one thread for non-urgent marks (tool chatter). */
export const ORGANIZATION_OBSERVATION_INTERVAL_MS = 1_000;

/** Coalesces observations only. Canonical commands and native proposals are never dropped.
 * Urgent marks are ready immediately; a non-urgent mark of a thread refreshed less than the
 * interval ago waits ("cooling") until the interval has passed. Both count toward capacity,
 * and overflow requests a full membership rescan instead of failing.
 */
export class OrganizationObservation {
  private readonly ready = new Set<string>();
  private readonly cooling = new Map<string, number>();
  /** Last take per thread, in take order; pruned once older than the interval. */
  private readonly recent = new Map<string, number>();
  rescan = false;
  constructor(
    private readonly capacity = 2000,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = ORGANIZATION_OBSERVATION_INTERVAL_MS,
  ) {}
  mark(threadId: string, urgent = true) {
    if (this.ready.has(threadId)) return;
    const at = this.now();
    const cooling = this.cooling.has(threadId);
    const takenAt = this.recent.get(threadId);
    if (!urgent && takenAt !== undefined && takenAt + this.intervalMs > at) {
      if (!cooling && this.admit()) this.cooling.set(threadId, takenAt + this.intervalMs);
      return;
    }
    if (cooling) this.cooling.delete(threadId);
    else if (!this.admit()) return;
    this.ready.add(threadId);
  }
  take() {
    const at = this.now();
    for (const [id, due] of this.cooling)
      if (due <= at) {
        this.cooling.delete(id);
        this.ready.add(id);
      }
    for (const [id, takenAt] of this.recent) {
      if (at - takenAt < this.intervalMs) break;
      this.recent.delete(id);
    }
    const id = this.ready.values().next().value;
    if (id === undefined) return undefined;
    this.ready.delete(id);
    this.recent.delete(id);
    this.recent.set(id, at);
    return id;
  }
  get size() {
    return this.ready.size + this.cooling.size;
  }
  private admit() {
    if (this.size < this.capacity) return true;
    this.rescan = true;
    return false;
  }
}

export function organizationObservationIds(event: OrchestrationEvent): readonly string[] {
  // Assistant streaming/content updates never change work, attention or deliberate activity.
  if (event.type === "thread.message-sent" && event.payload.role !== "user") return [];
  if (event.type === "thread.deleted")
    return [...new Set([event.payload.threadId, ...(event.payload.threadIds ?? [])])];
  return event.aggregateKind === "thread" ? [event.aggregateId] : [];
}

const ATTENTION_ACTIVITY = /approval|user-input|model-choice/;

/** Only ordinary activity (tool chatter) is throttled. Attention requests/resolutions, turns,
 * sessions, tasks, user messages, organisation updates and deletions stay immediate.
 */
export function organizationObservationUrgent(event: OrchestrationEvent): boolean {
  return (
    event.type !== "thread.activity-appended" ||
    ATTENTION_ACTIVITY.test(event.payload.activity.kind)
  );
}
