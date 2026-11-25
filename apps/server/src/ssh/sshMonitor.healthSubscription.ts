/**
 * Bounded per-subscriber SSH-owner status fan-out.
 *
 * One sample is published to every subscriber. A subscriber that falls behind
 * keeps at most `capacity` events; when full, its queue becomes one `resync`
 * plus the newest status, so memory stays bounded and the latest state always
 * wins. Publishing never awaits a reader, so one stalled subscriber cannot
 * block the owner, another subscriber, or the sampler.
 *
 * Status is typed: `unavailable` means "could not sample" (denial, cooldown,
 * owner loss), and must never be treated as an observed transport failure.
 * `unreachable` is the only observed failure. A generation change is a resync,
 * not a transport outcome.
 */

export type SshOwnerStatusSample = "reachable" | "unreachable" | "unavailable";

export interface SshOwnerStatus {
  readonly targetId: string;
  readonly generation: number;
  readonly sample: SshOwnerStatusSample;
  readonly observedAt: number;
}

export type SshOwnerStatusEvent =
  | { readonly kind: "status"; readonly status: SshOwnerStatus }
  | { readonly kind: "resync"; readonly reason: "overflow" | "generation" }
  | { readonly kind: "closed" };

export interface SshOwnerStatusSubscriber {
  readonly id: number;
  readonly closed: boolean;
  drain(): readonly SshOwnerStatusEvent[];
  close(): void;
}

interface SubscriberState {
  readonly id: number;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
  events: SshOwnerStatusEvent[];
  closed: boolean;
}

const MIN_CAPACITY = 2;

export class SshOwnerStatusBroker {
  readonly targetId: string;
  private generation: number;
  private readonly capacity: number;
  private readonly subscribers = new Map<number, SubscriberState>();
  private nextId = 1;
  private publishedSequence = 0;
  private closed = false;

  constructor(targetId: string, generation = 0, capacity = 2) {
    if (!targetId) throw new Error("A status broker needs an exact target.");
    if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY) {
      throw new Error(`A status queue needs capacity >= ${MIN_CAPACITY}.`);
    }
    this.targetId = targetId;
    this.generation = generation;
    this.capacity = capacity;
  }

  get subscriberCount() {
    let count = 0;
    for (const state of this.subscribers.values()) {
      if (!state.closed) count += 1;
    }
    return count;
  }

  subscribe(signal?: AbortSignal): SshOwnerStatusSubscriber {
    if (this.closed) return closedSubscriber(0);
    if (signal?.aborted) return closedSubscriber(0);
    const id = this.nextId++;
    const state: SubscriberState = {
      id,
      signal,
      onAbort: () => this.closeSubscriber(id),
      events: [],
      closed: false,
    };
    signal?.addEventListener("abort", state.onAbort, { once: true });
    this.subscribers.set(id, state);
    return {
      id,
      get closed() {
        return state.closed;
      },
      drain: () => this.drain(id),
      close: () => this.closeSubscriber(id),
    };
  }

  /**
   * Publish one sample. `sequence` is assigned before the probe starts, so an
   * older in-flight sample that completes late is dropped instead of being
   * relabelled as the newest. A stale generation only queues a resync.
   */
  publish(
    sample: SshOwnerStatusSample,
    generation = this.generation,
    sequence = this.publishedSequence + 1,
  ) {
    if (this.closed || sequence <= this.publishedSequence) return;
    this.publishedSequence = sequence;
    if (generation !== this.generation) {
      this.resync("generation");
      return;
    }
    const status: SshOwnerStatus = {
      targetId: this.targetId,
      generation,
      sample,
      observedAt: Date.now(),
    };
    for (const state of this.subscribers.values()) {
      this.offer(state, { kind: "status", status });
    }
  }

  /** A new owner generation invalidates queued status without a new sample. */
  setGeneration(generation: number) {
    if (this.closed || generation === this.generation) return;
    this.generation = generation;
    this.resync("generation");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.subscribers.values()) {
      this.offer(state, { kind: "closed" });
      state.signal?.removeEventListener("abort", state.onAbort);
      state.closed = true;
    }
  }

  private resync(reason: "overflow" | "generation") {
    for (const state of this.subscribers.values()) {
      this.offer(state, { kind: "resync", reason });
    }
  }

  private offer(state: SubscriberState, event: SshOwnerStatusEvent) {
    if (state.closed) return;
    if (event.kind === "resync" && state.events.at(-1)?.kind === "resync") {
      return;
    }
    if (state.events.length < this.capacity) {
      state.events.push(event);
      return;
    }
    // Coalesce: one resync plus the newest non-resync event. The reader must
    // re-read state instead of receiving an unbounded backlog.
    state.events = [{ kind: "resync", reason: "overflow" }];
    if (event.kind !== "resync") state.events.push(event);
  }

  private drain(id: number): readonly SshOwnerStatusEvent[] {
    const state = this.subscribers.get(id);
    if (!state) return [];
    const events = state.events;
    state.events = [];
    return events;
  }

  private closeSubscriber(id: number) {
    const state = this.subscribers.get(id);
    if (!state || state.closed) return;
    state.closed = true;
    state.events = [];
    state.signal?.removeEventListener("abort", state.onAbort);
    this.subscribers.delete(id);
  }
}

function closedSubscriber(id: number): SshOwnerStatusSubscriber {
  return {
    id,
    closed: true,
    drain: () => [],
    close: () => undefined,
  };
}
