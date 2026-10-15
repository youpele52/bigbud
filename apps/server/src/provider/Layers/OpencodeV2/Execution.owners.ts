/** Proof that a dispatched-then-failed execution has no remaining physical effect to join. */
export interface V2ExecutionSettlementEvidence {
  /** The exact native session is absent from `session.active`. */
  readonly nativeDrained: boolean;
  /** Terminal receipt, or a non-terminal one with no canonical handler still in flight (never re-executed). */
  readonly receiptDurable: boolean;
  /** A native interrupt was acknowledged after this execution failed. */
  readonly interruptAcknowledged: boolean;
}

export interface V2UncertainExecution {
  readonly controller: AbortController;
  readonly receiptKey: string | undefined;
  /** Monotonic order against interrupt acknowledgements; never a wall-clock deadline. */
  readonly failedSequence: number;
}

let settlementSequence = 0;
/** Orders failures against interrupt acknowledgements within this process. */
export const nextV2SettlementSequence = () => ++settlementSequence;

/** Exact session-owned executions: cancellation is synchronous and joins physical operation settlement outside queues. */
export class V2ActiveExecutions {
  private readonly uncertain = new Map<AbortController, V2UncertainExecution>();
  private readonly active = new Map<
    AbortController,
    { operation: Promise<unknown>; dispatched: boolean; receiptKey?: string | undefined }
  >();
  run<T>(controller: AbortController, run: () => Promise<T>): Promise<T> {
    if (this.active.size + this.uncertain.size >= 32)
      return Promise.reject(new Error("V2 active execution owner capacity rejected."));
    const operation = Promise.resolve().then(run);
    this.active.set(controller, { operation, dispatched: false });
    return operation
      .catch((error) => {
        const owned = this.active.get(controller);
        if (owned?.dispatched)
          this.uncertain.set(controller, {
            controller,
            receiptKey: owned.receiptKey,
            failedSequence: nextV2SettlementSequence(),
          });
        throw error;
      })
      .finally(() => {
        this.active.delete(controller);
      });
  }
  dispatch<T>(controller: AbortController, run: () => Promise<T>, receiptKey?: string): Promise<T> {
    controller.signal.throwIfAborted();
    const owned = this.active.get(controller);
    if (!owned) throw new Error("V2 active execution owner missing.");
    owned.dispatched = true;
    owned.receiptKey = receiptKey;
    return run().then((value) => {
      owned.dispatched = false;
      return value;
    });
  }
  async cancel(): Promise<void> {
    const operations = [...this.active];
    for (const [controller] of operations) controller.abort();
    // A blocked approval publication has no physical process to join. Its aborted guard still forbids dispatch.
    await Promise.allSettled(
      operations.filter(([, owned]) => owned.dispatched).map(([, owned]) => owned.operation),
    );
  }

  /** Observation/join never cancels an executor to manufacture idle. */
  busyCount() {
    return this.active.size + this.uncertain.size;
  }
  async join() {
    await Promise.allSettled([...this.active.values()].map((value) => value.operation));
  }
  uncertainEntries(): ReadonlyArray<V2UncertainExecution> {
    return [...this.uncertain.values()];
  }
  /** Release one uncertain executor only with proof (mirrors `V2ActivationGate.settle`); never by timer. */
  reconcile(controller: AbortController, evidence: V2ExecutionSettlementEvidence) {
    if (!this.uncertain.has(controller) || this.active.has(controller)) return false;
    if (!evidence.nativeDrained || !(evidence.receiptDurable || evidence.interruptAcknowledged))
      return false;
    this.uncertain.delete(controller);
    return true;
  }
}
