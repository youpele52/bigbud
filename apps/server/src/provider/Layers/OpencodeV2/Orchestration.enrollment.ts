import { randomBytes, sign, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import { callV2ThreadRpc } from "./Client.guard.orchestration.ts";
import { v2OwnerRegistration } from "./Orchestration.registration.ts";
import { detachV2Enrollment } from "./Orchestration.enrollment.detach.ts";
import {
  signV2ThreadEnvelope,
  v2ThreadOwnerDigest,
  V2_ENROLLMENT_PROTOCOL,
  V2ThreadOwner,
  type V2ThreadEnvelope,
} from "./Orchestration.protocol.ts";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { recoverV2PreviousEnrollment } from "./Orchestration.enrollment.recovery.ts";
import type { V2DeadBackendContext } from "./Orchestration.enrollment.deadBackend.ts";
import { V2EnrollmentControls } from "./Orchestration.enrollment.controls.ts";
import {
  V2EnrollmentRetirement,
  type V2RetirementProof,
} from "./Orchestration.enrollment.retirement.ts";
import {
  V2EnrollmentRecord as Record,
  V2EnrollmentLease as Lease,
  decodeV2EnrollmentRecord,
  digestV2EnrollmentOwner,
  v2CleanupEnvelope,
  type V2AnyEnrollmentOwner,
} from "./Orchestration.enrollment.record.ts";

type EnrollmentRecord = typeof Record.Type;
const Ack = Schema.Struct({
  state: Schema.Literals(["active", "expired", "revoked", "missing", "superseded"]),
  ownerDigest: Schema.String,
  enrollmentNonce: Schema.String,
  revision: Schema.Int,
  expiry: Schema.Int,
});

export interface V2EnrollmentOptions {
  readonly records: V2ThreadRecords;
  readonly privateKey: string;
  readonly client: OpencodeV2Client;
  readonly owner: V2ThreadOwner;
  readonly transport: string;
  readonly assertCurrent: () => void;
  readonly retirementProof?: (signal?: AbortSignal) => Promise<V2RetirementProof>;
  /** Present only while this process holds the state-directory lock for these records. */
  readonly deadBackend?: V2DeadBackendContext | undefined;
  /** Attributes the new owner to this backend instance before its record first persists. */
  readonly recordOwner?: ((digest: string, enrollmentNonce: string) => Promise<void>) | undefined;
}

/** Acknowledged authority and pending renewal are distinct; signed request deadlines are never owner identity. */
export class V2ThreadEnrollment {
  readonly digest: string;
  readonly controller = new AbortController();
  private record: EnrollmentRecord;
  private version: string | undefined;
  private readonly key: string;
  private updating = false;
  private settlement: Promise<void> | undefined;
  private ensuring: Promise<void> | undefined;
  private revoked = false;
  private challenge: string | undefined;
  private paused = false;
  private readonly controls = new V2EnrollmentControls();
  constructor(readonly options: V2EnrollmentOptions) {
    this.digest = v2ThreadOwnerDigest(options.owner);
    this.key = JSON.stringify([
      options.owner.storageIdentity,
      options.owner.nativeSessionId,
      options.owner.threadId,
    ]);
    this.record = {
      owner: options.owner,
      digest: this.digest,
      state: "pending",
      acknowledged: null,
      pending: null,
    };
  }

  assertLive() {
    this.options.assertCurrent();
    if (
      this.revoked ||
      this.controller.signal.aborted ||
      this.record.state !== "active" ||
      !this.record.acknowledged ||
      this.record.acknowledged.expiry <= Date.now()
    )
      throw new Error("Required V2 thread-tools enrollment is not acknowledged/live.");
  }

  matches(token: string, digest: string, nonce: string) {
    const expected = this.options.owner.callbackToken;
    return (
      token.length === 64 &&
      timingSafeEqual(Buffer.from(token), Buffer.from(expected)) &&
      digest === this.digest &&
      nonce === this.options.owner.enrollmentNonce
    );
  }

  assertCallbackLease(revision: number, expiry: number) {
    this.assertLive();
    if (
      this.record.acknowledged?.revision !== revision ||
      this.record.acknowledged.expiry !== expiry
    )
      throw new Error("V2 callback acknowledged lease mismatch; reconcile retained proposal.");
  }

  acknowledgedLease() {
    this.assertLive();
    return { ...this.record.acknowledged! };
  }

  assertPendingLease(revision: number, expiry: number) {
    this.options.assertCurrent();
    if (
      this.revoked ||
      this.controller.signal.aborted ||
      !this.record.pending ||
      revision !== this.record.pending.revision ||
      expiry !== this.record.pending.expiry ||
      expiry <= Date.now()
    )
      throw new Error("V2 callback pending lease owner lost.");
  }

  /** Only the current exact pending proposal can prove callback ownership. Initial pending state cannot invoke. */
  proof(revision: number, expiry: number, challenge: string) {
    this.options.assertCurrent();
    if (
      this.revoked ||
      this.controller.signal.aborted ||
      !this.record.pending ||
      revision !== this.record.pending.revision ||
      expiry !== this.record.pending.expiry ||
      expiry <= Date.now() ||
      expiry > Date.now() + 60000 ||
      this.challenge === challenge
    )
      throw new Error("V2 thread-tools callback proposal rejected.");
    if (this.record.acknowledged) this.assertLive();
    this.challenge = challenge;
    return {
      signature: sign(
        null,
        Buffer.from(JSON.stringify(["callback-proof", this.digest, revision, expiry, challenge])),
        this.options.privateKey,
      ).toString("base64url"),
    };
  }

  private envelope(
    operation: V2ThreadEnvelope["operation"],
    owner = this.options.owner,
    lease?: typeof Lease.Type,
  ) {
    return signV2ThreadEnvelope(
      {
        protocol: V2_ENROLLMENT_PROTOCOL,
        operation,
        issuer: owner.issuer,
        ownerDigest: v2ThreadOwnerDigest(owner),
        enrollmentNonce: owner.enrollmentNonce,
        requestId: randomBytes(16).toString("hex"),
        authExpiresAt: Date.now() + 14000,
        leaseRevision: lease?.revision ?? null,
        leaseExpiresAt: lease?.expiry ?? null,
        owner: operation === "enroll" ? owner : null,
      },
      this.options.privateKey,
    );
  }

  private async persist() {
    this.version = await this.options.records.replace(this.key, this.version, this.record);
  }

  private async rpc(
    operation: V2ThreadEnvelope["operation"],
    owner: V2AnyEnrollmentOwner = this.options.owner,
    lease?: typeof Lease.Type,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    this.controls.assertCapacity();
    const value = await callV2ThreadRpc(
      this.options.client,
      owner.directory,
      operation,
      operation === "inspect" || operation === "detach"
        ? v2CleanupEnvelope(owner, operation, this.options.privateKey)
        : this.envelope(operation, Schema.decodeUnknownSync(V2ThreadOwner)(owner), lease),
      owner.nativeSessionId,
      (operation) => this.controls.observe(operation),
      signal,
      v2OwnerRegistration(owner),
    );
    const ack = Schema.decodeUnknownSync(Ack)(value, { onExcessProperty: "error" });
    if (
      ack.ownerDigest !== digestV2EnrollmentOwner(owner) ||
      ack.enrollmentNonce !== owner.enrollmentNonce
    )
      throw new Error("V2 thread-tools enrollment acknowledgment mismatch.");
    return ack;
  }

  private async update<T>(run: () => Promise<T>) {
    if (this.updating) throw new Error("V2 thread-tools enrollment update busy.");
    this.updating = true;
    let complete!: () => void;
    this.settlement = new Promise((resolve) => {
      complete = resolve;
    });
    try {
      return await run();
    } finally {
      this.updating = false;
      complete();
      this.settlement = undefined;
    }
  }

  start() {
    return this.update(() => this.startExclusive());
  }

  private async startExclusive() {
    this.options.assertCurrent();
    const saved = await this.options.records.read(this.key);
    this.options.assertCurrent();
    if (saved) {
      await recoverV2PreviousEnrollment(
        this.options.records,
        saved,
        this.options.owner,
        this.options.transport,
        (operation, owner) => this.rpc(operation, owner),
        this.options.deadBackend,
      );
      this.options.assertCurrent();
      this.version = saved.revision;
    }
    await this.options.recordOwner?.(this.digest, this.options.owner.enrollmentNonce);
    this.options.assertCurrent();
    this.record = { ...this.record, pending: { revision: 1, expiry: Date.now() + 55000 } };
    await this.persist();
    this.options.assertCurrent();
    await this.settle("enroll");
    if (saved)
      await (
        await V2EnrollmentRetirement.open(this.options.records)
      ).replacementBound(
        this.retirementIdentity(decodeV2EnrollmentRecord(saved.value).owner),
        this.digest,
      );
  }

  private async settle(operation: "enroll" | "renew") {
    const proposal = this.record.pending;
    if (!proposal) throw new Error("V2 thread-tools proposal missing.");
    this.options.assertCurrent();
    const ack = await this.rpc(operation, this.options.owner, proposal);
    this.options.assertCurrent();
    if (
      this.revoked ||
      ack.state !== "active" ||
      ack.revision !== proposal.revision ||
      ack.expiry !== proposal.expiry
    )
      throw new Error("V2 thread-tools proposal acknowledgment unconfirmed.");
    this.record = { ...this.record, state: "active", acknowledged: proposal, pending: null };
    await this.persist();
    this.assertLive();
  }

  /** No new revision/nonce bypasses a lost acknowledgment. Readback can promote only the retained proposal. */
  async ensure() {
    this.options.assertCurrent();
    if (!this.ensuring) {
      const pending = this.update(() => this.ensureExclusive());
      this.ensuring = pending;
      void pending
        .finally(() => {
          if (this.ensuring === pending) this.ensuring = undefined;
        })
        .catch(() => {});
    }
    // Waiters own their continuation, not the shared renewal; only owner revocation fences it.
    await this.ensuring;
    this.assertLive();
  }

  private async ensureExclusive() {
    this.options.assertCurrent();
    if (this.revoked) throw new Error("V2 thread-tools enrollment revoked.");
    if (this.record.pending) {
      const ack = await this.rpc("inspect");
      this.options.assertCurrent();
      const proposal = this.record.pending;
      if (this.revoked) throw new Error("V2 thread-tools enrollment revoked.");
      if (
        ack.state === "active" &&
        ack.revision === proposal.revision &&
        ack.expiry === proposal.expiry
      ) {
        this.record = { ...this.record, state: "active", acknowledged: proposal, pending: null };
        await this.persist();
      } else if (
        ack.state === "active" &&
        this.record.acknowledged &&
        ack.revision === this.record.acknowledged.revision &&
        ack.expiry === this.record.acknowledged.expiry
      ) {
        this.assertLive();
        await this.settle("renew");
      } else throw new Error("V2 thread-tools retained proposal unresolved; no reenrollment.");
    }
    this.assertLive();
    if (!this.paused && this.record.acknowledged!.expiry - Date.now() < 40000) {
      this.record = {
        ...this.record,
        pending: { revision: this.record.acknowledged!.revision + 1, expiry: Date.now() + 55000 },
      };
      this.challenge = undefined;
      await this.persist();
      this.assertLive();
      await this.settle("renew");
    }
    this.assertLive();
  }

  /** Local authority is synchronously fenced before any asynchronous persistence or native cleanup. */
  revoke() {
    this.revoked = true;
    this.controller.abort();
  }
  pauseRenewal() {
    this.paused = true;
  }
  resumeRenewal() {
    if (!this.revoked) this.paused = false;
  }
  renewalPaused() {
    return this.paused;
  }
  controlCount() {
    return this.controls.count() + (this.updating ? 1 : 0);
  }
  async joinControl(signal: AbortSignal) {
    await this.controls.join(signal, this.settlement);
  }

  private retirementIdentity(owner: V2AnyEnrollmentOwner) {
    return {
      wireProtocol: owner.protocol,
      ownerDigest: digestV2EnrollmentOwner(owner),
      enrollmentNonce: owner.enrollmentNonce,
      directory: owner.directory,
      nativeSessionId: owner.nativeSessionId,
    };
  }

  async detach(signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.revoke();
    await this.controls.join(signal ?? new AbortController().signal, this.settlement);
    signal?.throwIfAborted();
    return detachV2Enrollment(
      {
        ...this.options,
        key: this.key,
        digest: this.digest,
        leases: () => [this.record.acknowledged, this.record.pending],
        persistRevoked: async () => {
          this.record = { ...this.record, state: "revoked" };
          await this.persist();
        },
        rpc: (method) => this.rpc(method, this.options.owner, undefined, signal),
      },
      signal,
    );
  }
}
