import type { OpenCodeEvent } from "@opencode/client";

import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { checkedV2EventConnection } from "./EventHub.connection.ts";
import { isV2LocationlessExecutionStart } from "./EventHub.hints.ts";
import {
  V2ChildIndex,
  V2_MAX_CHILDREN_PER_OWNER,
  isV2ChildHintEvent,
  v2CreatedChild,
} from "./EventHub.children.ts";

export interface V2EventOwner {
  readonly nativeSessionId: string;
  readonly location: string;
  readonly onEvent: (event: OpenCodeEvent, signal: AbortSignal) => Promise<void>;
  /** Dirty is sticky until authoritative reconciliation, never a terminal claim. */
  readonly onDirty: (reason: "gap" | "overflow" | "ambiguous" | "consumer-failed") => void;
  /** Request a fresh caller-owned read after an aborted delivery has finished unwinding. */
  readonly onDrained?: () => void;
  /** A known native child changed; the owner may refresh its read-only observer. */
  readonly onChildHint?: () => void;
}

type Owner = V2EventOwner & {
  queue: OpenCodeEvent[];
  draining: boolean;
  active: boolean;
  dirty: boolean;
  dirtyGeneration: number;
  arrivalGeneration: number;
  delivery: AbortController;
  reconcileAfterDrain: boolean;
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
  private readonly children = new V2ChildIndex();
  private readonly ownedChildren = new V2ChildIndex();
  private controller: AbortController | undefined;
  private task: Promise<void> | undefined;
  private closed = false;
  private connected = false;

  constructor(
    private readonly input: {
      readonly subscribe: (
        signal: AbortSignal,
        activity?: () => void,
      ) => AsyncIterable<OpenCodeEvent>;
      readonly requireMarker?: boolean;
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
      arrivalGeneration: 0,
      delivery: new AbortController(),
      reconcileAfterDrain: false,
    };
    this.owners.set(owner.nativeSessionId, record);
    return () => {
      record.active = false;
      record.delivery.abort();
      record.queue.length = 0;
      if (this.owners.get(owner.nativeSessionId) === record) {
        this.owners.delete(owner.nativeSessionId);
        this.children.forget(owner.nativeSessionId);
        this.ownedChildren.forget(owner.nativeSessionId);
      }
    };
  }

  /** A source gap ends this generation; restart explicitly after repairing projections. */
  start(): void {
    if (this.closed) throw new Error("OpenCode v2 event hub is closed.");
    if (this.task) return;
    const controller = new AbortController();
    this.controller = controller;
    this.connected = !this.input.requireMarker;
    this.task = this.consume(controller).finally(() => {
      if (this.controller === controller) {
        this.connected = false;
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

  /** Local arrival fence, not a native atomic snapshot or protection against events still in transit. */
  captureArrivalFence(nativeSessionId: string): (() => void) | undefined {
    const owner = this.owners.get(nativeSessionId),
      controller = this.controller;
    if (
      !owner?.active ||
      !controller ||
      controller.signal.aborted ||
      !this.connected ||
      this.closed
    )
      return undefined;
    const arrival = owner.arrivalGeneration,
      dirty = owner.dirtyGeneration;
    return () => {
      if (
        this.closed ||
        !this.connected ||
        this.controller !== controller ||
        controller.signal.aborted ||
        this.owners.get(nativeSessionId) !== owner ||
        !owner.active ||
        owner.arrivalGeneration !== arrival ||
        owner.dirtyGeneration !== dirty
      )
        throw new Error(
          "V2 native event arrival/connection changed; closure evidence retained, not settled.",
        );
    };
  }

  /** Children returned by an owner's own observer read; bounded per owner. */
  noteChildren(ownerSessionId: string, childIds: ReadonlyArray<string>): void {
    if (this.closed || !this.owners.has(ownerSessionId)) return;
    for (const childId of childIds) this.children.learn(ownerSessionId, childId);
  }

  /** Executable membership comes only from durable before-prompt enrollment, not discovery. */
  noteOwnedChildren(ownerSessionId: string, childIds: readonly string[]): void {
    if (this.closed || !this.owners.has(ownerSessionId)) return;
    if (new Set(childIds).size !== childIds.length || childIds.length > V2_MAX_CHILDREN_PER_OWNER)
      throw new Error("V2 owned child hint capacity rejected.");
    this.ownedChildren.forget(ownerSessionId);
    for (const id of childIds)
      if (!this.ownedChildren.learn(ownerSessionId, id))
        throw new Error("V2 owned child hint ownership conflict.");
  }

  isDirty(nativeSessionId: string): boolean {
    return this.owners.get(nativeSessionId)?.dirty ?? false;
  }

  reconciled(nativeSessionId: string, generation = this.generation(nativeSessionId)): boolean {
    const owner = this.owners.get(nativeSessionId);
    if (!owner || this.closed || generation !== owner.dirtyGeneration) return false;
    // Healthy callback reconciliation is already in the current generation. Replacing
    // its delivery signal or treating its own drain as a gap would invalidate its output.
    if (!owner.dirty) return true;
    if (owner.draining) {
      owner.reconcileAfterDrain = true;
      return false;
    }
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

  /** Unknown IDs stay dropped; a known child only nudges its owner, never delivers content. */
  private hintChild(event: OpenCodeEvent, sessionID: string): void {
    const created = v2CreatedChild(event);
    if (created?.childId === sessionID && this.owners.has(created.parentId))
      this.children.learn(created.parentId, created.childId);
    const enrolledOwner = this.ownedChildren.ownerOf(sessionID);
    const ownerId = enrolledOwner ?? this.children.ownerOf(sessionID);
    const owner = ownerId === undefined ? undefined : this.owners.get(ownerId);
    if (!owner?.active || !owner.onChildHint || (!enrolledOwner && !isV2ChildHintEvent(event)))
      return;
    try {
      owner.onChildHint();
    } catch {
      /* A hint is advisory; the parent's own reconcile still observes children. */
    }
  }

  private async consume(controller: AbortController): Promise<void> {
    let sawMarker = false;
    try {
      const source = this.input.requireMarker
        ? checkedV2EventConnection({ subscribe: this.input.subscribe, signal: controller.signal })
        : this.input.subscribe(controller.signal);
      for await (const event of source) {
        if (this.closed || controller.signal.aborted) return;
        if (event.type === "server.connected") {
          if (sawMarker) this.markGap(); // A transport may reconnect inside its iterator.
          sawMarker = true;
          this.connected = true;
        }
        const envelope = event as {
          data?: { sessionID?: unknown; form?: { sessionID?: unknown } };
          location?: { directory?: unknown };
        };
        const sessionID = envelope.data?.sessionID ?? envelope.data?.form?.sessionID;
        if (typeof sessionID !== "string") continue;
        const owner = this.owners.get(sessionID);
        if (!owner) {
          this.hintChild(event, sessionID);
          continue;
        }
        // Invalidate observations BEFORE delivery queues, Location filtering, or an exclusive
        // consumer can delay processing. A locationless execution start is still activity.
        owner.arrivalGeneration++;
        // The pinned native start notification is allowed to omit Location. Never route it
        // as owned content or infer a source gap from this explicitly optional hint.
        if (isV2LocationlessExecutionStart(event, sessionID)) continue;
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
      controller.abort();
      if (!this.closed && this.controller === controller) this.markGap();
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
      if (owner.reconcileAfterDrain && owner.active && !this.closed) {
        owner.reconcileAfterDrain = false;
        try {
          owner.onDrained?.();
        } catch {
          /* Dirty remains sticky until another owned read. */
        }
      }
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
    this.children.clear();
    this.ownedChildren.clear();
    await runWithAbortableDeadline({
      operation: "OpenCode v2 stream cleanup",
      timeoutMs: 1000,
      run: async () => {
        await this.task;
      },
    }).catch(() => {});
  }
}
