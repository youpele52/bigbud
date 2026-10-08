import type { OpenCodeEvent } from "@opencode/client";

import { runWithAbortableDeadline } from "../../RequestDeadline.ts";

export interface V2EventOwner {
  readonly nativeSessionId: string;
  readonly location: string;
  readonly onEvent: (event: OpenCodeEvent, signal: AbortSignal) => Promise<void>;
  /** Dirty is sticky until authoritative reconciliation, never a terminal claim. */
  readonly onDirty: (reason: "gap" | "overflow" | "ambiguous" | "consumer-failed") => void;
}

type Owner = V2EventOwner & {
  queue: OpenCodeEvent[];
  draining: boolean;
  active: boolean;
  dirty: boolean;
  dirtyGeneration: number;
  delivery: AbortController;
};

export function validateV2EventHubBounds(input: {
  readonly maxOwners: number;
  readonly maxQueuedEvents: number;
  readonly maxEventBytes: number;
  readonly consumerTimeoutMs: number;
}): void {
  if (
    !Number.isSafeInteger(input.maxOwners) ||
    input.maxOwners < 1 ||
    !Number.isInteger(input.maxQueuedEvents) ||
    input.maxQueuedEvents < 1 ||
    !Number.isInteger(input.maxEventBytes) ||
    input.maxEventBytes < 1 ||
    !Number.isFinite(input.consumerTimeoutMs) ||
    input.consumerTimeoutMs <= 0
  ) {
    throw new Error("Invalid OpenCode v2 event hub bounds.");
  }
}

/** Single process stream, bounded per-owner buffers, no guessed Location routing. */
export class OpencodeV2EventHub {
  private readonly owners = new Map<string, Owner>();
  private controller: AbortController | undefined;
  private task: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly input: {
      readonly subscribe: (signal: AbortSignal) => AsyncIterable<OpenCodeEvent>;
      readonly maxOwners: number;
      readonly maxQueuedEvents: number;
      readonly maxEventBytes: number;
      readonly consumerTimeoutMs: number;
    },
  ) {
    validateV2EventHubBounds(input);
  }

  register(owner: V2EventOwner): () => void {
    if (
      this.closed ||
      this.owners.has(owner.nativeSessionId) ||
      this.owners.size >= this.input.maxOwners
    ) {
      throw new Error("OpenCode v2 event ownership conflict.");
    }
    const record: Owner = {
      ...owner,
      queue: [],
      draining: false,
      active: true,
      dirty: false,
      dirtyGeneration: 0,
      delivery: new AbortController(),
    };
    this.owners.set(owner.nativeSessionId, record);
    return () => {
      record.active = false;
      record.delivery.abort();
      record.queue.length = 0;
      if (this.owners.get(owner.nativeSessionId) === record)
        this.owners.delete(owner.nativeSessionId);
    };
  }

  /** A source gap ends this generation; restart explicitly after repairing projections. */
  start(): void {
    if (this.closed) throw new Error("OpenCode v2 event hub is closed.");
    if (this.task) return;
    const controller = new AbortController();
    this.controller = controller;
    this.task = this.consume(controller).finally(() => {
      if (this.controller === controller) {
        this.controller = undefined;
        this.task = undefined;
      }
    });
  }

  markGap(): void {
    for (const owner of this.owners.values()) this.dirty(owner, "gap");
  }

  /** Resume only after caller-owned authoritative repair and fencing have completed. */
  generation(nativeSessionId: string): number | undefined {
    return this.owners.get(nativeSessionId)?.dirtyGeneration;
  }

  isDirty(nativeSessionId: string): boolean {
    return this.owners.get(nativeSessionId)?.dirty ?? false;
  }

  reconciled(nativeSessionId: string, generation = this.generation(nativeSessionId)): boolean {
    const owner = this.owners.get(nativeSessionId);
    if (!owner || owner.draining || this.closed || generation !== owner.dirtyGeneration)
      return false;
    owner.delivery = new AbortController();
    owner.dirty = false;
    return true;
  }

  private dirty(owner: Owner, reason: Parameters<V2EventOwner["onDirty"]>[0]): void {
    owner.queue.length = 0;
    const notify = !owner.dirty;
    owner.dirty = true;
    owner.dirtyGeneration++;
    owner.delivery.abort();
    // Diagnostics must not break delivery to another owner.
    try {
      if (notify) owner.onDirty(reason);
    } catch {
      /* Caller still must reconcile before settlement. */
    }
  }

  private async consume(controller: AbortController): Promise<void> {
    try {
      for await (const event of this.input.subscribe(controller.signal)) {
        if (this.closed || controller.signal.aborted) return;
        const envelope = event as {
          data?: { sessionID?: unknown; form?: { sessionID?: unknown } };
          location?: { directory?: unknown };
        };
        const sessionID = envelope.data?.sessionID ?? envelope.data?.form?.sessionID;
        if (typeof sessionID !== "string") continue;
        const owner = this.owners.get(sessionID);
        if (!owner) continue;
        if (envelope.location?.directory !== owner.location) {
          this.dirty(owner, "ambiguous");
          continue;
        }
        if (owner.dirty) {
          this.dirty(owner, "gap");
          continue;
        }
        if (
          Buffer.byteLength(JSON.stringify(event)) > this.input.maxEventBytes ||
          owner.queue.length >= this.input.maxQueuedEvents
        ) {
          this.dirty(owner, "overflow");
          continue;
        }
        owner.queue.push(event);
        if (!owner.draining) void this.drain(owner, controller.signal);
      }
    } catch {
      /* A failed stream proves a gap, not completion or no admission. */
    } finally {
      if (!this.closed) this.markGap();
    }
  }

  private async drain(owner: Owner, signal: AbortSignal): Promise<void> {
    owner.draining = true;
    try {
      while (owner.active && !owner.dirty && !this.closed && !signal.aborted) {
        const event = owner.queue.shift();
        if (!event) break;
        await runWithAbortableDeadline({
          operation: "OpenCode v2 event consumer",
          timeoutMs: this.input.consumerTimeoutMs,
          signal: AbortSignal.any([signal, owner.delivery.signal]),
          run: (consumerSignal) => owner.onEvent(event, consumerSignal),
        });
      }
    } catch {
      if (owner.active && !this.closed) this.dirty(owner, "consumer-failed");
    } finally {
      owner.draining = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller?.abort();
    for (const owner of this.owners.values()) {
      owner.active = false;
      owner.delivery.abort();
      owner.queue.length = 0;
    }
    this.owners.clear();
    await runWithAbortableDeadline({
      operation: "OpenCode v2 stream cleanup",
      timeoutMs: 1000,
      run: async () => {
        await this.task;
      },
    }).catch(() => {});
  }
}
