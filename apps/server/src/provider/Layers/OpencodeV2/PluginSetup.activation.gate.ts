import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";

export interface V2ReadyStamp {
  readonly scope: string;
  readonly epoch: number;
  readonly directory: string;
  readonly bootstrapDigest: string;
  readonly setupInstanceId: string;
  readonly nativeProof?: V2NativeRuntimeProof;
}
export interface V2ExecutionReservation {
  readonly scope: string;
  readonly epoch: number;
  readonly key: string;
}
type Operation = {
  readonly token: V2ExecutionReservation;
  state: "reserved" | "dispatched" | "native-running" | "uncertain";
  physical?: Promise<unknown>;
  physicalSettled: boolean;
  readonly nativeProof?: V2NativeRuntimeProof;
};

/** One process's synchronous admission fence. External native clients remain an explicitly accepted race. */
export class V2ActivationGate {
  private epoch = 0;
  private expected: string;
  private closed: { job: string; deadline: number } | undefined;
  private readonly ready = new Map<string, V2ReadyStamp>();
  private readonly operations = new Map<string, Operation>();
  constructor(
    readonly scope: string,
    digest: string,
    private readonly assertCurrent: () => void,
    private readonly now = Date.now,
  ) {
    this.expected = digest;
  }
  verify(
    directory: string,
    digest: string,
    setupInstanceId: string,
    nativeProof?: V2NativeRuntimeProof,
  ): V2ReadyStamp {
    this.assertCurrent();
    nativeProof?.assertCurrent();
    if (nativeProof) {
      const scope = JSON.parse(this.scope) as unknown[];
      if (
        nativeProof.directory !== directory ||
        scope[0] !== nativeProof.root ||
        scope[2] !== nativeProof.transport ||
        scope[3] !== nativeProof.generation
      )
        throw new Error("V2 readiness compatibility proof scope/Location/generation changed.");
    }
    if (!this.ready.has(directory) && this.ready.size >= 64)
      throw new Error("V2 verified Location capacity reached; no stale readiness eviction.");
    if (digest !== this.expected || !setupInstanceId)
      throw new Error("V2 Location has not verified the expected activation epoch/digest.");
    const stamp = Object.freeze({
      scope: this.scope,
      epoch: this.epoch,
      directory,
      bootstrapDigest: digest,
      setupInstanceId,
      ...(nativeProof ? { nativeProof } : {}),
    });
    this.ready.set(directory, stamp);
    return stamp;
  }
  tryReserve(stamp: V2ReadyStamp, key: string): V2ExecutionReservation | undefined {
    this.assertCurrent();
    stamp.nativeProof?.assertCurrent();
    if (
      this.closed ||
      stamp.scope !== this.scope ||
      stamp.epoch !== this.epoch ||
      stamp.bootstrapDigest !== this.expected ||
      this.ready.get(stamp.directory) !== stamp
    )
      return undefined;
    if (this.operations.has(key)) throw new Error("V2 execution reservation already owned.");
    if (this.operations.size >= 32)
      throw new Error("V2 local execution/quarantine capacity reached.");
    const token = Object.freeze({ scope: this.scope, epoch: this.epoch, key });
    this.operations.set(key, {
      token,
      state: "reserved",
      physicalSettled: true,
      ...(stamp.nativeProof ? { nativeProof: stamp.nativeProof } : {}),
    });
    return token;
  }
  assertReservation(token: V2ExecutionReservation) {
    this.assertCurrent();
    this.operations.get(token.key)?.nativeProof?.assertCurrent();
    if (
      this.operations.get(token.key)?.token !== token ||
      token.scope !== this.scope ||
      token.epoch !== this.epoch
    )
      throw new Error("V2 admission reservation changed; dispatch rejected.");
  }
  dispatch<T>(token: V2ExecutionReservation, begin: () => Promise<T>): Promise<T> {
    this.assertReservation(token);
    const operation = this.operations.get(token.key)!;
    if (operation.physical && !operation.physicalSettled)
      throw new Error("V2 physical operation is already pending.");
    operation.state = "dispatched";
    operation.physicalSettled = false;
    let physical: Promise<T>;
    try {
      physical = begin();
    } catch (error) {
      operation.state = "uncertain";
      operation.physicalSettled = true;
      throw error;
    }
    operation.physical = physical;
    void physical.then(
      () => {
        operation.physicalSettled = true;
      },
      () => {
        operation.physicalSettled = true;
        operation.state = "uncertain";
      },
    );
    return physical;
  }
  nativeRunning(token: V2ExecutionReservation) {
    this.assertReservation(token);
    this.operations.get(token.key)!.state = "native-running";
  }
  uncertain(token: V2ExecutionReservation) {
    this.assertReservation(token);
    this.operations.get(token.key)!.state = "uncertain";
  }
  cancelUndispatched(token: V2ExecutionReservation) {
    const operation = this.operations.get(token.key);
    if (operation?.token !== token || operation.state !== "reserved" || operation.physical)
      return false;
    this.operations.delete(token.key);
    return true;
  }
  isUndispatched(token: V2ExecutionReservation) {
    const operation = this.operations.get(token.key);
    return operation?.token === token && operation.state === "reserved" && !operation.physical;
  }
  settle(
    token: V2ExecutionReservation,
    evidence: {
      physical: boolean;
      durable: boolean;
      nativeDrained: boolean;
      callbacksSettled: boolean;
    },
  ) {
    const operation = this.operations.get(token.key);
    if (!operation) return;
    // Exact old-owner settlement is cleanup, not new admission: revision revocation cannot orphan its physical evidence.
    if (operation.token !== token || token.scope !== this.scope)
      throw new Error("V2 settlement successor token rejected.");
    if (
      !operation.physicalSettled ||
      !evidence.physical ||
      !evidence.durable ||
      !evidence.nativeDrained ||
      !evidence.callbacksSettled
    )
      throw new Error("V2 physical/native/durable settlement unproved; reservation remains busy.");
    this.operations.delete(token.key);
  }
  tryCloseGate(job: string) {
    this.assertCurrent();
    if (this.closed || this.operations.size) return false;
    this.closed = { job, deadline: this.now() + 15000 };
    return true;
  }
  assertOpen() {
    this.assertCurrent();
    if (this.closed)
      throw new Error("V2 activation gate is closed; no new callback/admission authority.");
  }
  knownReady(directory: string) {
    this.assertOpen();
    return this.ready.get(directory);
  }
  assertGate(job: string) {
    this.assertCurrent();
    if (!this.closed || this.closed.job !== job || this.now() >= this.closed.deadline)
      throw new Error("V2 activation gate authority expired/changed; no new publication.");
  }
  gateDeadline(job: string) {
    this.assertGate(job);
    return this.closed!.deadline;
  }
  beforePublication(job: string, digest: string) {
    this.assertGate(job);
    this.epoch++;
    this.expected = digest;
    this.ready.clear();
  }
  releaseGate(job: string) {
    if (this.closed?.job !== job) throw new Error("V2 activation gate successor preserved.");
    this.closed = undefined;
  }
  invalidate(digest = this.expected) {
    this.epoch++;
    this.expected = digest;
    this.ready.clear();
  }
  busyCount() {
    return this.operations.size;
  }
  /** Read-only diagnostics: no tokens, stamps, proofs or job identities, and no authority. */
  snapshot() {
    return {
      closed: this.closed !== undefined,
      epoch: this.epoch,
      operations: [...this.operations.values()].map(({ token, state, physicalSettled }) => ({
        key: token.key,
        state,
        physicalSettled,
      })),
    };
  }
  expectedDigest() {
    return this.expected;
  }
  adoptRetained(digest: string) {
    this.assertCurrent();
    if (this.expected === digest) return;
    if (this.epoch !== 0 || this.closed || this.operations.size)
      throw new Error("V2 retained bootstrap cannot bypass a committed/pending activation epoch.");
    this.expected = digest;
    this.ready.clear();
  }
}
