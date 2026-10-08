import type { ThreadId, ProviderRuntimeEvent } from "@bigbud/contracts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { releaseV2Session } from "./Runtime.cleanup.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";
import { observeV2Mutation } from "./Mutation.ts";
import {
  flushV2FinalEvents,
  needsV2FinalRepair,
  queueV2FinalEvents,
} from "./Runtime.finalization.ts";

interface Teardown {
  readonly owner: V2RuntimeSession;
  completion: Promise<void>;
  pending: number;
  unconfirmed: boolean;
  finished: boolean;
  unsubscribeDeath: () => void;
  repairQueued?: boolean;
  repairTimer?: ReturnType<typeof setTimeout>;
}

/** Exact-owner join plus bounded binding quarantine: a deadline is not native cancellation. */
export class V2RuntimeTeardown {
  private readonly owners = new Map<ThreadId, Teardown>();
  private shuttingDown = false;

  constructor(
    private readonly runtime: {
      readonly sessions: Map<ThreadId, V2RuntimeSession>;
      readonly serialize: (owner: V2RuntimeSession, run: () => Promise<void>) => Promise<void>;
      readonly emit: (owner: V2RuntimeSession, event: ProviderRuntimeEvent) => Promise<void>;
      readonly finalizeLoss: (owner: V2RuntimeSession) => Promise<void>;
    },
  ) {}

  has(threadId: ThreadId): boolean {
    this.releaseDead();
    return this.owners.has(threadId);
  }

  /** Counts unique owned/quarantined IDs; uncertain bindings consume capacity until safe. */
  capacity(): number {
    this.releaseDead();
    return new Set([...this.runtime.sessions.keys(), ...this.owners.keys()]).size;
  }

  private release(record: Teardown): void {
    if (
      !record.finished ||
      needsV2FinalRepair(record.owner) ||
      ((record.pending || record.unconfirmed) && !record.owner.lease.process.hasExited?.())
    )
      return;
    if (this.owners.get(record.owner.threadId) !== record) return;
    this.owners.delete(record.owner.threadId);
    if (this.runtime.sessions.get(record.owner.threadId) === record.owner)
      this.runtime.sessions.delete(record.owner.threadId);
    record.unsubscribeDeath();
    clearTimeout(record.repairTimer);
  }

  releaseDead(): void {
    for (const record of this.owners.values()) this.release(record);
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    for (const record of this.owners.values()) this.settle(record);
  }

  private observe(record: Teardown, operation: Promise<unknown>): void {
    observeV2Mutation(record, operation, () => this.release(record));
  }

  /** Physical-exit settlement survives stopped polling and failed shutdown; one serialized retry per owner. */
  private settle(record: Teardown): void {
    if (
      this.owners.get(record.owner.threadId) !== record ||
      record.repairQueued ||
      !record.owner.lease.process.hasExited?.()
    )
      return;
    record.repairQueued = true;
    void this.runtime
      .serialize(record.owner, async () => {
        if (record.owner.lossPending) await this.runtime.finalizeLoss(record.owner);
        else await flushV2FinalEvents(record.owner, this.runtime.emit);
      })
      .catch(() => {})
      .finally(() => {
        record.repairQueued = false;
        this.release(record);
        if (
          this.shuttingDown &&
          this.owners.get(record.owner.threadId) === record &&
          record.finished &&
          needsV2FinalRepair(record.owner) &&
          !record.repairTimer
        ) {
          record.repairTimer = setTimeout(() => {
            delete record.repairTimer;
            this.settle(record);
          }, 1000);
          record.repairTimer.unref();
        }
      });
  }

  /** Called from the owner's serialized polling queue, never repeats native cleanup. */
  async repair(owner: V2RuntimeSession): Promise<boolean> {
    const record = this.owners.get(owner.threadId);
    if (!record || record.owner !== owner) return false;
    if (record.finished) {
      await flushV2FinalEvents(owner, this.runtime.emit);
      this.release(record);
    }
    return true;
  }

  stop(threadId: ThreadId, expected?: V2RuntimeSession): Promise<void> {
    const current = this.owners.get(threadId);
    if (current)
      return !expected || expected === current.owner ? current.completion : Promise.resolve();
    const owner = this.runtime.sessions.get(threadId);
    if (!owner || (expected && expected !== owner)) return Promise.resolve();
    owner.stopped = true;
    owner.coding?.revoke();
    owner.unregister();
    owner.unsubscribeDeath();
    const record: Teardown = {
      owner,
      completion: Promise.resolve(),
      pending: 0,
      unconfirmed: false,
      finished: false,
      unsubscribeDeath: () => {},
    };
    this.owners.set(threadId, record);
    record.completion = this.runtime
      .serialize(owner, async () => {
        await owner.coding?.cancelActive();
        let cleanupError: unknown;
        try {
          await releaseV2Session(owner, (request) => this.observe(record, request));
        } catch (error) {
          // Without a still-observed operation that can settle, cleanup uncertainty
          // needs generation death rather than a speculative successful rebind.
          if (!record.pending) record.unconfirmed = true;
          cleanupError = error;
        }
        if (!cleanupError && owner.lossPending === undefined)
          queueV2FinalEvents(owner, [
            {
              ...runtimeEventBase(owner, `stopped:${owner.lease.generation}:${owner.epoch}`),
              type: "session.exited",
              payload: { reason: "Session stopped; native history retained" },
            },
          ]);
        try {
          await flushV2FinalEvents(owner, this.runtime.emit);
        } catch (error) {
          throw cleanupError ?? error;
        }
        if (cleanupError) throw cleanupError;
      })
      .finally(() => {
        record.finished = true;
        this.release(record);
        this.settle(record);
      });
    record.unsubscribeDeath = owner.lease.process.onDeath(() => {
      this.release(record);
      this.settle(record);
    });
    return record.completion;
  }

  /** Includes quarantined failed owners removed from the ordinary session map. */
  drain(): Promise<void> {
    const pending = [...this.owners.values()].map((record) => record.completion);
    for (const threadId of this.runtime.sessions.keys()) pending.push(this.stop(threadId));
    return Promise.all(pending).then(() => {});
  }
}
