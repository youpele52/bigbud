import type { RootOp } from "@bigbud/contracts/terminal-owner/identity";
import { canonicalDomain, encodeCanonical } from "./canonical";
import { sha256 } from "./auth";
import { requireContract } from "./errors";
import { OwnerReservationModel } from "./reservation.model";
import { CleanupSettlementModel } from "./cleanup.model.settlement";
import { commitCleanupReceipt } from "./cleanup.model.receipt";
import { OwnerShutdownInventoryModel } from "./shutdownInventory.model";
import { captureCleanupInventory } from "./cleanup.model.inventory";
import type { CleanupGrantResult } from "@bigbud/contracts/terminal-owner/auth";
import { CleanupGrantModel } from "./cleanupGrant.model";
import {
  CleanupChildRecordsModel,
  cleanupHex as hex,
  cleanupU32 as u32,
  type CleanupResource as Resource,
  type CleanupParent,
  type CleanupAttempt as Attempt,
} from "./cleanup.model.records";

/** Pure §7.4a custody/outcome model: proofs are injected, never inferred from child exit. */
export class OwnerCleanupModel {
  readonly reservations = new OwnerReservationModel();
  private ordinary = new Map<string, string>();
  private ptys: Resource[] = [];
  private auxiliary: Resource[] = [];
  private children: CleanupChildRecordsModel;
  private parent: CleanupParent | undefined;
  private attempts: Attempt[] = [];
  private settlement = new CleanupSettlementModel();
  private inventory: OwnerShutdownInventoryModel | undefined;
  private grants: CleanupGrantModel | undefined;
  private observedRevision = "0";
  private lastNow = 0;
  constructor(
    private readonly epoch: Uint8Array,
    private currentMainSession: Uint8Array,
  ) {
    requireContract(epoch.length === 32 && epoch.some((b) => b !== 0), "IDENTITY_INVALID");
    this.epoch = epoch.slice();
    this.children = new CleanupChildRecordsModel(this.epoch);
    requireContract(
      currentMainSession.length === 32 && currentMainSession.some((b) => b !== 0),
      "IDENTITY_INVALID",
    );
    this.currentMainSession = currentMainSession.slice();
    this.reservations.rootEnvelope();
  }
  admitOrdinary(id: string, digest: string, bytes: number) {
    requireContract(
      /^[a-f0-9]{64}$/.test(id) && /^[a-f0-9]{64}$/.test(digest) && bytes >= 320,
      "IDENTITY_INVALID",
    );
    requireContract(!this.parent && !this.ordinary.has(id) && bytes <= 1024, "ADMISSION_CLOSED");
    this.reservations.ordinaryRoot.reserve(bytes);
    this.ordinary.set(id, digest);
  }
  reserveResource(
    kind: "pty" | "auxiliary",
    identity: Uint8Array,
    disposition: "pending" | "live" = "pending",
    started = false,
    generation = "1",
  ): number {
    requireContract(
      !this.parent && identity.length === 32 && identity.some((b) => b !== 0),
      "ADMISSION_CLOSED",
    );
    const list = kind === "pty" ? this.ptys : this.auxiliary;
    requireContract(list.length < (kind === "pty" ? 64 : 30), "CAPACITY");
    requireContract(
      ![...this.ptys, ...this.auxiliary].some((r) => hex(r.identity) === hex(identity)),
      "IDENTITY_CONFLICT",
    );
    const slot = list.length;
    encodeCanonical("Generations", { main: generation, controller: "0", host: "0" });
    requireContract(BigInt(generation) > 0n, "IDENTITY_INVALID");
    list.push({
      identity: identity.slice(),
      disposition,
      started: started || disposition === "live",
      generation,
    });
    return slot;
  }
  completePending(slot: number, disposition: "live" | "uncertain" | "clean") {
    const resource = this.ptys[slot];
    requireContract(
      resource &&
        resource.disposition === "pending" &&
        (!this.parent || resource.started || disposition === "clean"),
      "ADMISSION_CLOSED",
    );
    resource.disposition = disposition;
    this.settlement.changed();
  }
  begin(op: RootOp, shutdownId: Uint8Array) {
    encodeCanonical("RootOp", op);
    requireContract(
      BigInt(op.sequence) > 0n &&
        op.attemptId.some((b) => b !== 0) &&
        shutdownId.length === 32 &&
        shutdownId.some((b) => b !== 0),
      "IDENTITY_INVALID",
    );
    const digest = hex(
      sha256(canonicalDomain("cleanup-parent-model/v1"), encodeCanonical("RootOp", op), shutdownId),
    );
    if (this.parent) {
      requireContract(digest === this.parent.digest, "DIGEST_CONFLICT");
      return this.parentStatus();
    }
    const { cut, inventory } = captureCleanupInventory(
      this.epoch,
      op,
      shutdownId,
      this.ptys,
      this.auxiliary,
      this.ordinary,
    );
    this.reservations.cleanupParent.reserve(1024);
    this.parent = { op: structuredClone(op), shutdownId: shutdownId.slice(), digest, cut };
    for (let slot = 0; slot < 2; slot++)
      this.auxiliary.push({
        identity: sha256(
          canonicalDomain("cleanup-attempt-model/v1"),
          this.epoch,
          shutdownId,
          u32(slot + 1),
        ),
        disposition: "pending",
        started: false,
        generation: "0",
      });
    // Attempt slots always 30/31, even with fewer ordinary auxiliary reservations.
    const attempts = this.auxiliary.splice(this.auxiliary.length - 2);
    this.auxiliary[30] = attempts[0]!;
    this.auxiliary[31] = attempts[1]!;
    for (let i = 0; i < this.ptys.length; i++) this.reserveChild(1, i, this.ptys[i]!.identity);
    for (let i = 0; i < 32; i++)
      if (this.auxiliary[i]) this.reserveChild(2, i, this.auxiliary[i]!.identity);
    for (let i = 0; i < 16; i++) this.reserveChild(3, i, cut);
    this.inventory = new OwnerShutdownInventoryModel(inventory);
    this.grants = new CleanupGrantModel(inventory);
    return this.parentStatus();
  }
  private reserveChild(kind: 1 | 2 | 3, slot: number, identity: Uint8Array) {
    this.children.reserve(kind, slot, identity, this.parent!);
  }
  query(kind: 1 | 2 | 3, slot: number) {
    return this.children.query(kind, slot);
  }
  accept(
    kind: 1 | 2 | 3,
    slot: number,
    operation: number,
    typedPayloadWithoutRef: Uint8Array,
    preconditionsProven: boolean,
  ) {
    const child = this.query(kind, slot);
    if (operation === 22 && !child.digest)
      requireContract(
        this.settlement.hasReceipt &&
          this.ptys.every((r) => r.disposition === "clean") &&
          this.auxiliary.every((r) => r.disposition === "clean") &&
          this.children.settledExcept([`${kind}:${slot}`]),
        "CLEANUP_UNKNOWN",
      );
    if (operation === 28 && !child.digest)
      requireContract(this.settlement.hasReceipt, "RECEIPT_INVALID");
    if (this.children.accept(kind, slot, operation, typedPayloadWithoutRef, preconditionsProven))
      this.settlement.childChanged(kind, slot);
    return this.query(kind, slot);
  }
  disposition(kind: 1 | 2 | 3, slot: number, provenClean: boolean) {
    const changed = this.children.disposition(kind, slot, provenClean);
    if (changed && !provenClean) this.settlement.changed();
    const resource = kind === 1 ? this.ptys[slot] : kind === 2 ? this.auxiliary[slot] : undefined;
    if (resource) {
      const disposition = provenClean ? "clean" : "uncertain";
      if (resource.disposition !== disposition)
        this.settlement.resourceChanged(kind, slot, provenClean);
      resource.disposition = disposition;
    } else if (changed) this.settlement.childChanged(kind, slot);
  }
  private clock(now: number) {
    requireContract(Number.isSafeInteger(now) && now >= this.lastNow, "CLOCK_INVALID");
    this.lastNow = now;
  }
  reserveAttempt(number: number, now: number, formerWriterVerifiedStopped: boolean) {
    this.clock(now);
    if (this.attempts[number - 1]) return this.query(3, number === 1 ? 9 : 12);
    requireContract(
      !this.settlement.isFrozen &&
        number === this.attempts.length + 1 &&
        number <= 2 &&
        formerWriterVerifiedStopped &&
        this.attempts.every((a) => a.stopped),
      "ATTEMPT_BLOCKED",
    );
    this.accept(3, number === 1 ? 9 : 12, 40, u32(number), true);
    const attempt = { launched: true, stopped: false, expiresAt: now + 30000 };
    this.attempts.push(attempt);
    this.auxiliary[29 + number]!.started = true;
    this.auxiliary[29 + number]!.disposition = "live";
    return this.query(3, number === 1 ? 9 : 12);
  }
  issueAttemptGrant(number: number, result: CleanupGrantResult, now: number) {
    this.clock(now);
    const attempt = this.attempts[number - 1];
    requireContract(
      attempt && !attempt.stopped && now < attempt.expiresAt && this.grants,
      "ATTEMPT_EXPIRED",
    );
    this.grants.issue(result, number, now, attempt.expiresAt);
    return this.issueAttemptCapsule(number, encodeCanonical("CleanupGrantResult", result), now);
  }
  cleanupGrants() {
    requireContract(this.grants, "PARENT_UNKNOWN");
    return this.grants;
  }
  private issueAttemptCapsule(number: number, capsule: Uint8Array, now: number) {
    this.clock(now);
    const attempt = this.attempts[number - 1];
    requireContract(
      attempt && !attempt.stopped && now < attempt.expiresAt && capsule.length <= 8192,
      "ATTEMPT_EXPIRED",
    );
    if (attempt.capsule) {
      requireContract(hex(attempt.capsule) === hex(capsule), "DIGEST_CONFLICT");
      return hex(sha256(attempt.capsule));
    }
    const copy = this.reservations.cleanupCopies.reserve(capsule.length);
    try {
      const retained = capsule.slice();
      this.accept(3, number === 1 ? 10 : 13, 31, sha256(capsule), true);
      attempt.capsule = retained;
      attempt.issuer = this.currentMainSession.slice();
      return hex(sha256(attempt.capsule));
    } finally {
      this.reservations.cleanupCopies.release(copy);
    }
  }
  replayAttempt(number: number, now: number, requesterSession: Uint8Array) {
    this.clock(now);
    const attempt = this.attempts[number - 1];
    requireContract(
      attempt?.capsule && !attempt.stopped && now < attempt.expiresAt,
      "ATTEMPT_EXPIRED",
    );
    requireContract(
      attempt.issuer &&
        hex(requesterSession) === hex(this.currentMainSession) &&
        hex(attempt.issuer) === hex(this.currentMainSession),
      "ROLE_DENIED",
    );
    const permit = this.reservations.cleanupCopies.reserve(attempt.capsule.length);
    let released = false;
    return {
      bytes: attempt.capsule.slice(),
      release: () => {
        requireContract(!released, "RESERVATION_UNKNOWN");
        released = true;
        this.reservations.cleanupCopies.release(permit);
      },
    };
  }
  /** Inject only the result of the separate verified root CAS; no credential issuance or floor reset. */
  installVerifiedMainSession(session: Uint8Array) {
    requireContract(session.length === 32 && session.some((b) => b !== 0), "IDENTITY_INVALID");
    this.currentMainSession = session.slice();
  }
  stopAttempt(number: number, verified: boolean) {
    const attempt = this.attempts[number - 1];
    requireContract(attempt, "ATTEMPT_BLOCKED");
    this.grants?.revokeAttempt(number);
    this.accept(2, 29 + number, 0, u32(number), true);
    this.disposition(2, 29 + number, verified);
    if (verified) {
      attempt.stopped = true;
      this.accept(3, number === 1 ? 11 : 14, 0, u32(number), true);
      this.disposition(3, number === 1 ? 11 : 14, true);
    }
  }
  freezeInventory() {
    const writer =
      this.settlement.snapshot().writer ?? this.attempts.findIndex((a) => !a.stopped) + 1;
    const exceptions = [
      "3:4",
      "3:6",
      "3:7",
      "3:15",
      `2:${29 + writer}`,
      `3:${writer === 1 ? 11 : 14}`,
    ];
    requireContract(
      this.parent &&
        writer > 0 &&
        this.ptys.every((r) => r.disposition === "clean") &&
        this.auxiliary.every(
          (r, slot) =>
            r.disposition === "clean" || (slot === 29 + writer && r.disposition === "live"),
        ) &&
        this.children.settledExcept(exceptions),
      "SETTLEMENT_PENDING",
    );
    return this.settlement.freeze(this.parent.cut, writer);
  }
  reportFinalReceipt(cut: Uint8Array, receipt: Uint8Array, number: number, now: number) {
    this.clock(now);
    const attempt = this.attempts[number - 1];
    requireContract(attempt && !attempt.stopped && now < attempt.expiresAt, "RECEIPT_INVALID");
    commitCleanupReceipt(this.settlement, this.children, cut, receipt, number);
  }
  retryObservation(revision: string) {
    requireContract(
      /^(0|[1-9][0-9]{0,19})$/.test(revision) &&
        BigInt(revision) <= 18446744073709551615n &&
        BigInt(revision) >= BigInt(this.observedRevision),
      "CLOCK_INVALID",
    );
    this.observedRevision = revision;
    this.children.observe();
    return this.parentStatus();
  }
  readyToHandoff() {
    return (
      this.settlement.hasReceipt &&
      this.ptys.every((r) => r.disposition === "clean") &&
      this.auxiliary.every((r) => r.disposition === "clean") &&
      this.children.size === this.ptys.length + this.auxiliary.filter(Boolean).length + 16 &&
      this.children.settledExcept([])
    );
  }
  parentStatus() {
    requireContract(this.parent, "PARENT_UNKNOWN");
    return { ...structuredClone(this.parent), observedRevision: this.observedRevision };
  }
  snapshot() {
    requireContract(!this.parent || this.inventory, "PARENT_UNKNOWN");
    return {
      rootEnvelope: this.reservations.rootEnvelope(),
      rootRecords:
        this.ordinary.size +
        (this.parent ? 1 : 0) +
        this.reservations.authorityRoot.snapshot().items,
      ordinary: [...this.ordinary],
      floor: "0",
      children: this.children.snapshot(),
      ptys: this.ptys.length,
      auxiliary: this.auxiliary.filter(Boolean).length,
      attempts: this.attempts.length,
      capsules: this.attempts.filter((a) => a.capsule).length,
      ready: this.readyToHandoff(),
      settlement: this.settlement.snapshot(),
    };
  }
  inventorySnapshot() {
    requireContract(this.inventory, "PARENT_UNKNOWN");
    return this.inventory.snapshot();
  }
}
