import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { OwnedV2Process } from "./ServerManager.child.ts";
import { observeV2Mutation, type V2MutationObservation } from "./Mutation.ts";
import { v2Request } from "./Client.ts";

interface Mutation extends V2MutationObservation {
  readonly process: OwnedV2Process;
  failed: boolean;
  verifying: boolean;
  readonly verify: () => Promise<boolean>;
}

/** One bounded quarantine for this runtime's fixed storage/process namespace. No TTL discharge. */
export class V2RuntimeMutations {
  private current: Mutation | undefined;
  private queue = Promise.resolve();
  private waiting = 0;

  /** Acquisition and mutation dispatch share a bounded namespace queue; uncertainty outlives it. */
  async withNamespace<T>(run: () => Promise<T>): Promise<T> {
    this.assertSafe();
    if (this.waiting >= 32) throw new Error("V2 namespace operation capacity rejected.");
    this.waiting++;
    const pending = this.queue.then(async () => {
      this.assertSafe();
      return run();
    });
    this.queue = pending.then(
      () => {},
      () => {},
    );
    try {
      return await pending;
    } finally {
      this.waiting--;
    }
  }

  assertSafe(): void {
    if (this.current?.process.hasExited?.()) this.current = undefined;
    if (this.current)
      throw new Error("V2 native mutation is unconfirmed; process namespace quarantined.");
  }

  private verify(record: Mutation): void {
    if (
      this.current !== record ||
      !record.failed ||
      record.pending ||
      record.unconfirmed ||
      record.verifying
    )
      return;
    record.verifying = true;
    void record
      .verify()
      .then(
        (verified) => {
          if (verified && this.current === record) this.current = undefined;
        },
        () => {},
      )
      .finally(() => {
        record.verifying = false;
      });
  }

  async run<T>(
    session: V2RuntimeSession,
    operation: string,
    request: (signal: AbortSignal) => Promise<T>,
    verify: () => Promise<boolean>,
    timeoutMs = 10000,
    beforeDispatch?: () => Promise<() => void>,
  ): Promise<T> {
    return this.withNamespace(async () => {
      const validate = await beforeDispatch?.();
      return this.runOwned(
        session.lease.process,
        operation,
        request,
        verify,
        timeoutMs,
        undefined,
        false,
        validate,
      );
    });
  }

  /** Caller holds withNamespace; startup has no published session owner yet. */
  async runOwned<T>(
    process: OwnedV2Process,
    operation: string,
    request: (signal: AbortSignal) => Promise<T>,
    verify: () => Promise<boolean>,
    timeoutMs = 10000,
    signal?: AbortSignal,
    verifySuccess = false,
    validateDispatch?: () => void,
  ): Promise<T> {
    this.assertSafe();
    const record: Mutation = {
      process,
      pending: 0,
      unconfirmed: false,
      failed: false,
      verifying: false,
      verify,
    };
    this.current = record;
    try {
      const result = await v2Request(
        operation,
        (signal) => {
          try {
            validateDispatch?.();
          } catch (error) {
            // Rejected before invoking native code: no unknown mutation was dispatched.
            if (this.current === record) this.current = undefined;
            throw error;
          }
          try {
            const original = request(signal);
            observeV2Mutation(record, original, () => this.verify(record));
            return original;
          } catch (error) {
            record.unconfirmed = true;
            throw error;
          }
        },
        { timeoutMs, ...(signal ? { signal } : {}) },
      );
      if (verifySuccess && !(await verify()))
        throw new Error("V2 native mutation state unverified.");
      if (this.current === record) this.current = undefined;
      return result;
    } catch (error) {
      record.failed = true;
      this.verify(record);
      throw error;
    }
  }

  /** A bounded explicit read may retry failed verification, never a rejected native mutation. */
  retryVerification(): void {
    if (this.current) this.verify(this.current);
  }
}
