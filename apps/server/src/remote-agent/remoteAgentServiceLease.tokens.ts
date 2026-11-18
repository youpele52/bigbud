import type {
  RemoteAgentServiceLeaseStart as Start,
  RemoteAgentServiceLeaseResponse as Response,
} from "./remoteAgentProtocol.serviceLease.ts";
import {
  NativeLeaseAttempts,
  type OriginalNativeLeaseAttempt,
} from "./remoteAgentServiceLease.attempt.ts";
import {
  copyBinding,
  equalNativeLeaseBinding,
  nativeLeaseBindingView,
  nativeLeaseEvidence,
  snapshotNativeLeaseReference,
  validateNativeLeaseReference,
  validateFreshNativeLease,
  type NativeLeaseRestore,
  type NativeLeaseEvidence,
  type NativeLeaseExitEvidence,
  type NativeLeaseCancellationEvidence,
} from "./remoteAgentServiceLease.identity.ts";
declare const pending: unique symbol,
  lease: unique symbol,
  exit: unique symbol,
  cancel: unique symbol,
  never: unique symbol,
  attaching: unique symbol;
export interface PendingOriginalNativeLease {
  readonly [pending]: true;
}
export interface VerifiedNativeLease {
  readonly [lease]: true;
}
/** Successor Resume #1 grant: bootstrap only, never readiness, until native verifies the socket. */
export interface AttachingNativeLease {
  readonly [attaching]: true;
}
export interface ConfirmedNativeLeaseExit {
  readonly [exit]: true;
}
export interface ConfirmedNativeCancelFence {
  readonly [cancel]: true;
}
export interface OriginalNeverInvoked {
  readonly [never]: true;
}
export type NativeLeaseCancellation = ConfirmedNativeCancelFence | OriginalNeverInvoked;
interface Record {
  readonly reference: NativeLeaseRestore;
  start: Start | undefined;
  invoked: boolean;
  cancelled: boolean;
  attached: boolean;
  generation: number;
  bootstrap: Response["bootstrap"];
}
export class NativeLeaseTokens {
  private readonly pending = new WeakMap<PendingOriginalNativeLease, Record>();
  private readonly grants = new WeakMap<
    VerifiedNativeLease,
    { pending: PendingOriginalNativeLease; evidence: NativeLeaseEvidence }
  >();
  private readonly attachments = new WeakMap<
    AttachingNativeLease,
    { pending: PendingOriginalNativeLease; evidence: NativeLeaseEvidence }
  >();
  private readonly exits = new WeakMap<ConfirmedNativeLeaseExit, NativeLeaseExitEvidence>();
  private readonly fences = new WeakMap<object, NativeLeaseCancellationEvidence>();
  private readonly records = new Set<Record>();
  private readonly nonces = new Set<string>();
  private readonly attempts = new NativeLeaseAttempts();
  beginAttempt() {
    return this.attempts.begin();
  }
  attemptNonce(token: OriginalNativeLeaseAttempt) {
    return this.attempts.nonce(token);
  }
  constructor(
    private readonly epoch: string,
    private readonly stateDir: string,
  ) {}
  private retain(reference: NativeLeaseRestore, start?: Start): PendingOriginalNativeLease {
    if (this.records.size >= 64 || this.nonces.has(reference.binding.nonce))
      throw Error("Native lease history capacity or duplicate original nonce refused.");
    validateNativeLeaseReference(reference, this.epoch);
    const token = Object.freeze({}) as PendingOriginalNativeLease;
    const record: Record = {
      reference: snapshotNativeLeaseReference(reference),
      start,
      invoked: !start,
      cancelled: false,
      attached: false,
      generation: 0,
      bootstrap: [],
    };
    this.pending.set(token, record);
    this.records.add(record);
    this.nonces.add(reference.binding.nonce);
    return token;
  }
  prepare(attempt: OriginalNativeLeaseAttempt, input: Start): PendingOriginalNativeLease {
    validateFreshNativeLease(input, this.epoch, this.stateDir);
    const start: Start = {
      ...input,
      binding: input.binding ? copyBinding(input.binding) : undefined,
      capability: Uint8Array.from(input.capability),
      guard: Uint8Array.from(input.guard),
      assetsReceiptSha256: Uint8Array.from(input.assetsReceiptSha256),
      args: [...input.args],
      environment: input.environment.map((v) => ({ name: v.name, value: v.value })),
    };
    validateFreshNativeLease(start, this.epoch, this.stateDir);
    if (!start.binding) throw Error("Original native lease binding required.");
    this.attempts.consume(attempt, start.binding.nonce);
    return this.retain({ ...start, binding: start.binding }, start);
  }
  restore(input: NativeLeaseRestore): PendingOriginalNativeLease {
    return this.retain(input);
  }
  original(token: PendingOriginalNativeLease) {
    const record = this.pending.get(token);
    if (!record) throw Error("Original owner-client pending token required.");
    return record;
  }
  invoke(token: PendingOriginalNativeLease) {
    const record = this.original(token);
    if (record.cancelled) throw Error("Original native start is cancelled.");
    if (!record.start)
      throw Error("Retained native intent requires reconciliation, not replayed Start.");
    record.invoked = true;
    return record.start;
  }
  neverInvoked(token: PendingOriginalNativeLease): OriginalNeverInvoked {
    const record = this.original(token);
    if (record.invoked || !record.start || record.cancelled)
      throw Error("Original start may already have been invoked.");
    record.cancelled = true;
    const proof = Object.freeze({}) as OriginalNeverInvoked;
    this.fences.set(
      proof,
      Object.freeze({
        kind: "never-invoked",
        binding: nativeLeaseBindingView(record.reference.binding),
      }),
    );
    return proof;
  }
  private hold(token: PendingOriginalNativeLease, response: Response) {
    const record = this.original(token);
    record.generation = response.generation;
    record.attached = true;
    record.bootstrap = (
      response.bootstrap.length ? response.bootstrap : (record.start?.environment ?? [])
    ).map((v) => ({ name: v.name, value: v.value }));
    return { pending: token, evidence: nativeLeaseEvidence(response) };
  }
  grant(token: PendingOriginalNativeLease, response: Response): VerifiedNativeLease {
    const proof = Object.freeze({}) as VerifiedNativeLease;
    this.grants.set(proof, this.hold(token, response));
    return proof;
  }
  /** A successor takeover: private bootstrap for the new upstream socket, no live grant. */
  attaching(token: PendingOriginalNativeLease, response: Response): AttachingNativeLease {
    if (!response.bootstrap.length) throw Error("Successor attach bootstrap is missing.");
    const proof = Object.freeze({}) as AttachingNativeLease;
    this.attachments.set(proof, this.hold(token, response));
    return proof;
  }
  /** The attaching pending token for exactly this successor generation. */
  attachingPending(proof: AttachingNativeLease) {
    const value = this.attachments.get(proof);
    if (!value) throw Error("Original successor attaching token required.");
    this.granted(proof);
    return value;
  }
  /** Readiness supersedes the attaching grant; it can never be replayed afterwards. */
  retireAttaching(proof: AttachingNativeLease) {
    this.attachments.delete(proof);
  }
  granted(proof: VerifiedNativeLease | AttachingNativeLease) {
    const value =
      this.grants.get(proof as VerifiedNativeLease) ??
      this.attachments.get(proof as AttachingNativeLease);
    if (!value) throw Error("Original owner-client lease token required.");
    const record = this.original(value.pending);
    if (record.cancelled || record.generation !== value.evidence.generation)
      throw Error("Native lease grant is stale.");
    return { ...value, record };
  }
  terminal(token: PendingOriginalNativeLease, response: Response): ConfirmedNativeLeaseExit {
    const record = this.original(token);
    if (
      !response.accepted ||
      response.state !== "exited" ||
      response.bootstrap.length ||
      !equalNativeLeaseBinding(response.binding, record.reference.binding) ||
      !response.originalController ||
      response.originalController.pid <= 1 ||
      !response.originalController.boot ||
      !/^\d+$/.test(response.originalController.started) ||
      !Number.isSafeInteger(response.originalChildPid) ||
      response.originalChildPid < 0
    )
      throw Error("Original native exit attestation is incomplete.");
    record.bootstrap = [];
    record.cancelled = true;
    record.attached = false;
    const proof = Object.freeze({}) as ConfirmedNativeLeaseExit;
    this.exits.set(proof, Object.freeze({ ...nativeLeaseEvidence(response), kind: "native-exit" }));
    return proof;
  }
  cancelled(token: PendingOriginalNativeLease, response: Response): ConfirmedNativeCancelFence {
    const record = this.original(token);
    if (
      !response.accepted ||
      response.state !== "cancelled" ||
      response.generation !== 0 ||
      response.originalChildPid !== 0 ||
      response.bootstrap.length ||
      response.originalController ||
      response.currentController ||
      response.previousController ||
      !equalNativeLeaseBinding(response.binding, record.reference.binding)
    )
      throw Error("Original native cancellation attestation is incomplete.");
    record.cancelled = true;
    record.bootstrap = [];
    const proof = Object.freeze({}) as ConfirmedNativeCancelFence;
    this.fences.set(
      proof,
      Object.freeze({
        kind: "native-cancel",
        binding: nativeLeaseBindingView(record.reference.binding),
      }),
    );
    return proof;
  }
  binding(token: PendingOriginalNativeLease) {
    return nativeLeaseBindingView(this.original(token).reference.binding);
  }
  originalView(token: PendingOriginalNativeLease) {
    const record = this.original(token);
    return Object.freeze({
      binding: this.binding(token),
      assetsReference: Object.freeze({
        schemaVersion: 1 as const,
        generation: record.reference.assetsGeneration,
        sizeBytes: record.reference.assetsReceiptSize,
        sha256: Buffer.from(record.reference.assetsReceiptSha256).toString("hex"),
      }),
      assetsArgument: record.reference.assetsArgument,
    });
  }
  exitView(proof: ConfirmedNativeLeaseExit): NativeLeaseExitEvidence {
    const value = this.exits.get(proof);
    if (!value) throw Error("Original confirmed native exit token required.");
    return value;
  }
  view(proof: VerifiedNativeLease | ConfirmedNativeLeaseExit): NativeLeaseEvidence {
    const evidence =
      this.grants.get(proof as VerifiedNativeLease)?.evidence ??
      this.exits.get(proof as ConfirmedNativeLeaseExit);
    if (!evidence) throw Error("Original native evidence token required.");
    return evidence;
  }
  cancellation(proof: NativeLeaseCancellation) {
    const value = this.fences.get(proof);
    if (!value) throw Error("Original native cancellation proof required.");
    return value;
  }
  clear() {
    for (const record of this.records) {
      record.reference.capability.fill(0);
      record.start?.capability.fill(0);
      record.start = undefined;
      record.bootstrap = [];
      record.cancelled = true;
    }
  }
}
