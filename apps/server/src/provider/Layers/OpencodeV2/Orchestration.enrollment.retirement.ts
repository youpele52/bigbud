import type { V2ThreadRecords } from "./Orchestration.records.ts";
import { assertV2RebootRetirement, v2RebootReceiptEvidence } from "./RebootRecovery.proof.ts";
import { recoveryDigest } from "./RebootRecovery.schema.ts";
import type { V2OperationAuthority } from "./Client.guard.ts";
import {
  validateV2DetachAcknowledgement,
  type V2EnrollmentAcknowledgement,
} from "./Orchestration.enrollment.ack.ts";
import {
  provedDeadBackend,
  provedFencedLive,
  verifyV2FencedReceiptProof,
  type V2DeadBackendRetirementProof,
  type V2ReceiptFenceReference,
} from "./Orchestration.enrollment.retirement.deadBackend.ts";

export interface V2RetirementIdentity {
  readonly wireProtocol: "bigbud.thread.v1" | "bigbud.thread.enrollment.v2";
  readonly ownerDigest: string;
  readonly enrollmentNonce: string;
  readonly directory: string;
  readonly nativeSessionId: string;
}
export interface V2RetirementProof {
  readonly physicalSettled: boolean;
  readonly controlsSettled: boolean;
  readonly callbacksSettled: boolean;
  readonly creationSettled: boolean;
  readonly admissionsSettled: boolean;
  readonly receiptsSettled: boolean;
  readonly rebootReceiptCheckpointDigest?: string;
  /** Q1: unknown receipt outcomes fenced by a dead-backend fence (decided 2026-10-15). */
  readonly deadBackendReceiptFence?: V2ReceiptFenceReference;
}
export type V2AnyRetirementProof = V2RetirementProof | V2DeadBackendRetirementProof;
interface Retirement {
  readonly format: "bigbud.thread.retirement.v1";
  readonly identity: V2RetirementIdentity;
  readonly archivedSignedEnrollment: unknown;
  readonly phase:
    | "retiring"
    | "detach-acknowledged"
    | "settled"
    | "replacement-bound"
    | "reboot-prepared";
  readonly detach?: {
    ack: V2EnrollmentAcknowledgement;
    evidence: "registry-absent" | "exact-entry";
    bootstrapDigest: string;
    transportGeneration: string;
  };
  readonly proof?: V2AnyRetirementProof;
  readonly replacementDigest?: string;
  readonly rebootCheckpointDigest?: string;
  /** A failed reboot retirement superseded by dead-backend proof; audit only, never authority. */
  readonly supersededRebootCheckpointDigest?: string;
}
const proofFields = [
  "physicalSettled",
  "controlsSettled",
  "callbacksSettled",
  "creationSettled",
  "admissionsSettled",
  "receiptsSettled",
] as const;
const proved = (value: unknown): value is V2RetirementProof =>
  Boolean(
    value &&
    typeof value === "object" &&
    Object.keys(value).length ===
      proofFields.length + ((value as V2RetirementProof).rebootReceiptCheckpointDigest ? 1 : 0) &&
    proofFields.every(
      (key) =>
        Object.hasOwn(value, key) &&
        ((value as V2RetirementProof)[key] === true ||
          (key === "receiptsSettled" &&
            (value as V2RetirementProof).receiptsSettled === false &&
            /^[a-f0-9]{64}$/.test(
              (value as V2RetirementProof).rebootReceiptCheckpointDigest ?? "",
            ))),
    ),
  );
/** The original rule above is unchanged; fence-bearing and dead-backend proofs are distinct
 * versioned shapes that older builds reject (fail closed). */
const provedLive = (value: unknown): value is V2RetirementProof =>
  proved(value) || provedFencedLive(value);
const provedAny = (value: unknown): value is V2AnyRetirementProof =>
  provedLive(value) || provedDeadBackend(value);
const fenced = (proof: V2AnyRetirementProof) =>
  "kind" in proof || proof.deadBackendReceiptFence !== undefined;

/** Native detach evidence and actual physical/durable settlement are separate, monotonic signed records. */
export class V2EnrollmentRetirement {
  private constructor(private readonly records: V2ThreadRecords) {}
  static async open(enrollments: V2ThreadRecords) {
    return new V2EnrollmentRetirement(await enrollments.sibling("retirements"));
  }
  private key(identity: V2RetirementIdentity) {
    return JSON.stringify([
      identity.wireProtocol,
      identity.ownerDigest,
      identity.enrollmentNonce,
      identity.directory,
      identity.nativeSessionId,
    ]);
  }
  private async verifyReceiptProof(proof: V2AnyRetirementProof, mode: "settle" | "read") {
    if (fenced(proof)) return verifyV2FencedReceiptProof(this.records, proof, mode);
    if (!("physicalSettled" in proof) || !proof.rebootReceiptCheckpointDigest) return;
    const current = await v2RebootReceiptEvidence(await this.records.sibling("receipts"));
    if (
      proof.receiptsSettled ||
      current.receiptsSettled ||
      current.rebootReceiptCheckpointDigest !== proof.rebootReceiptCheckpointDigest
    )
      throw new Error("V2 retirement requires exact reboot-fenced unknown receipt evidence.");
  }
  private async read(identity: V2RetirementIdentity) {
    const signed = await this.records.read(this.key(identity));
    if (!signed) return undefined;
    const value = signed.value as Retirement;
    if (
      !value ||
      value.format !== "bigbud.thread.retirement.v1" ||
      JSON.stringify(value.identity) !== JSON.stringify(identity) ||
      ![
        "retiring",
        "detach-acknowledged",
        "settled",
        "replacement-bound",
        "reboot-prepared",
      ].includes(value.phase) ||
      value.archivedSignedEnrollment === undefined
    )
      throw new Error("V2 retirement evidence is invalid; original identity retained.");
    return { signed, value };
  }
  async begin(identity: V2RetirementIdentity, archivedSignedEnrollment: unknown) {
    const previous = await this.read(identity);
    if (previous) return previous.value.phase;
    if (archivedSignedEnrollment === undefined)
      throw new Error("V2 retirement requires the exact prior signed enrollment evidence.");
    await this.records.replace(this.key(identity), undefined, {
      format: "bigbud.thread.retirement.v1",
      identity,
      archivedSignedEnrollment,
      phase: "retiring",
    });
    return "retiring" as const;
  }
  async acknowledge(
    identity: V2RetirementIdentity,
    value: unknown,
    inspected: V2EnrollmentAcknowledgement,
    bootstrapDigest: string,
    transportGeneration: string,
  ) {
    const previous = await this.read(identity);
    if (!previous) throw new Error("V2 retirement was not reserved before detach.");
    const verified = validateV2DetachAcknowledgement(
      value,
      { digest: identity.ownerDigest, nonce: identity.enrollmentNonce },
      inspected,
    );
    if (previous.value.phase !== "retiring") {
      if (JSON.stringify(previous.value.detach?.ack) !== JSON.stringify(verified.ack))
        throw new Error("V2 retirement detach acknowledgement changed; successor preserved.");
      return;
    }
    await this.records.replace(this.key(identity), previous.signed.revision, {
      ...previous.value,
      phase: "detach-acknowledged",
      detach: { ...verified, bootstrapDigest, transportGeneration },
    });
  }
  async settle(identity: V2RetirementIdentity, proof: V2AnyRetirementProof) {
    const previous = await this.read(identity);
    if (!previous?.value.detach || previous.value.phase === "retiring" || !provedAny(proof))
      throw new Error(
        "V2 physical retirement settlement is unproved; detach/registry absence/expiry does not release ownership.",
      );
    await this.verifyReceiptProof(proof, "settle");
    if (previous.value.phase === "settled" || previous.value.phase === "replacement-bound") return;
    await this.records.replace(this.key(identity), previous.signed.revision, {
      ...previous.value,
      phase: "settled",
      proof,
    });
  }
  async settleIfProved(identity: V2RetirementIdentity, proof: V2RetirementProof) {
    if (!provedLive(proof)) return false;
    await this.settle(identity, proof);
    return true;
  }
  async assertSettled(identity: V2RetirementIdentity) {
    const previous = await this.read(identity);
    if (
      previous?.value.rebootCheckpointDigest &&
      ["reboot-prepared", "replacement-bound"].includes(previous.value.phase)
    ) {
      if (previous.value.detach || previous.value.proof)
        throw new Error(
          "V2 reboot retirement cannot fabricate native detach or completed receipt evidence.",
        );
      await assertV2RebootRetirement(
        this.records,
        identity,
        previous.value.rebootCheckpointDigest,
        previous.value.archivedSignedEnrollment,
      );
      return;
    }
    if (
      !previous ||
      !["settled", "replacement-bound"].includes(previous.value.phase) ||
      !previous.value.detach ||
      !provedAny(previous.value.proof)
    )
      throw new Error(
        "V2 previous owner retirement is not durably physically settled; no replacement or history replay.",
      );
    await this.verifyReceiptProof(previous.value.proof!, "read");
  }
  /** Recovery reads the phase only; it never treats a record as authority by itself. */
  async state(identity: V2RetirementIdentity) {
    const previous = await this.read(identity);
    return previous
      ? {
          phase: previous.value.phase,
          rebootCheckpointDigest: previous.value.rebootCheckpointDigest,
        }
      : undefined;
  }
  /** Only after the reboot seal failed to prove retirement and dead-backend proof is available:
   * the stalled reboot record restarts native retirement; checkpoint/seal records are untouched. */
  async supersedeStalledReboot(identity: V2RetirementIdentity) {
    const previous = await this.read(identity);
    if (
      previous?.value.phase !== "reboot-prepared" ||
      !previous.value.rebootCheckpointDigest ||
      previous.value.detach ||
      previous.value.proof
    )
      throw new Error("V2 reboot retirement cannot be superseded; evidence retained.");
    const { rebootCheckpointDigest, ...rest } = previous.value;
    await this.records.replace(this.key(identity), previous.signed.revision, {
      ...rest,
      phase: "retiring",
      supersededRebootCheckpointDigest: rebootCheckpointDigest,
    });
  }
  /** Not authority by itself: assertSettled requires the independently verified final reboot seal. */
  async stageReboot(
    identity: V2RetirementIdentity,
    archivedSignedEnrollment: unknown,
    checkpointDigest: string,
    authority: V2OperationAuthority,
  ) {
    const previous = await this.read(identity);
    if (previous) {
      if (
        previous.value.rebootCheckpointDigest !== checkpointDigest ||
        recoveryDigest(previous.value.archivedSignedEnrollment) !==
          recoveryDigest(archivedSignedEnrollment)
      )
        throw new Error("V2 reboot retirement conflicts with existing evidence; preserved.");
      return;
    }
    await this.records.replace(
      this.key(identity),
      undefined,
      {
        format: "bigbud.thread.retirement.v1",
        identity,
        archivedSignedEnrollment,
        phase: "reboot-prepared",
        rebootCheckpointDigest: checkpointDigest,
      },
      authority,
    );
  }
  async replacementBound(identity: V2RetirementIdentity, replacementDigest: string) {
    await this.assertSettled(identity);
    const previous = (await this.read(identity))!;
    if (previous.value.phase === "replacement-bound") {
      if (previous.value.replacementDigest !== replacementDigest)
        throw new Error("V2 retirement replacement changed.");
      return;
    }
    await this.records.replace(this.key(identity), previous.signed.revision, {
      ...previous.value,
      phase: "replacement-bound",
      replacementDigest,
    });
  }
}
