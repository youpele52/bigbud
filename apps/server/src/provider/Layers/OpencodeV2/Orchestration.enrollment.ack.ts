import * as Schema from "effect/Schema";

export const V2EnrollmentAcknowledgement = Schema.Struct({
  state: Schema.Literals(["active", "expired", "revoked", "missing", "superseded"]),
  ownerDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  enrollmentNonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expiry: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type V2EnrollmentAcknowledgement = typeof V2EnrollmentAcknowledgement.Type;

/** Native readback may acknowledge only an exact retained proposal, never invent a later lease. */
export function validateV2LeaseInspection(
  value: V2EnrollmentAcknowledgement,
  expected: { digest: string; nonce: string },
  leases: readonly ({ readonly revision: number; readonly expiry: number } | null)[],
) {
  const inspected = Schema.decodeUnknownSync(V2EnrollmentAcknowledgement)(value, {
    onExcessProperty: "error",
  });
  const absent =
    ["missing", "revoked"].includes(inspected.state) &&
    inspected.revision === 0 &&
    inspected.expiry === 0;
  if (
    inspected.ownerDigest !== expected.digest ||
    inspected.enrollmentNonce !== expected.nonce ||
    (!absent &&
      (!["active", "expired", "revoked"].includes(inspected.state) ||
        !leases.some(
          (lease) =>
            lease && lease.revision === inspected.revision && lease.expiry === inspected.expiry,
        )))
  )
    throw new Error(
      "V2 native inspection does not reconcile the exact retained lease; cleanup/retirement stays unconfirmed.",
    );
  return inspected;
}

/** Zero/zero registry absence is cleanup evidence only, never physical operation settlement. */
export function validateV2DetachAcknowledgement(
  value: unknown,
  expected: { digest: string; nonce: string },
  inspected: V2EnrollmentAcknowledgement,
) {
  const ack = Schema.decodeUnknownSync(V2EnrollmentAcknowledgement)(value, {
    onExcessProperty: "error",
  });
  const absent =
    inspected.revision === 0 &&
    inspected.expiry === 0 &&
    ["missing", "revoked"].includes(inspected.state);
  if (
    inspected.ownerDigest !== expected.digest ||
    inspected.enrollmentNonce !== expected.nonce ||
    ack.ownerDigest !== expected.digest ||
    ack.enrollmentNonce !== expected.nonce ||
    ack.state !== "revoked" ||
    ack.revision !== inspected.revision ||
    ack.expiry !== inspected.expiry ||
    (!absent && (inspected.revision < 1 || inspected.expiry < 1))
  )
    throw new Error(
      "V2 exact previous-owner native detach acknowledgement rejected; retirement stays unconfirmed.",
    );
  return { ack, evidence: absent ? ("registry-absent" as const) : ("exact-entry" as const) };
}
