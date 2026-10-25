import { randomBytes } from "node:crypto";
import * as Schema from "effect/Schema";
import {
  V2ThreadOwner,
  signV2ThreadEnvelope,
  v2ThreadOwnerDigest,
} from "./Orchestration.protocol.ts";
import {
  V2LegacyThreadOwner,
  signV2LegacyCleanup,
  v2LegacyThreadOwnerDigest,
} from "./Orchestration.protocol.legacy.ts";

export const V2EnrollmentLease = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  expiry: Schema.Int,
});
const fields = {
  digest: Schema.String,
  state: Schema.Literals(["pending", "active", "revoked"]),
  acknowledged: Schema.NullOr(V2EnrollmentLease),
  pending: Schema.NullOr(V2EnrollmentLease),
};
export const V2EnrollmentRecord = Schema.Struct({ owner: V2ThreadOwner, ...fields });
export const V2LegacyEnrollmentRecord = Schema.Struct({ owner: V2LegacyThreadOwner, ...fields });
export type V2AnyEnrollmentOwner = V2ThreadOwner | V2LegacyThreadOwner;

/** No optional new fields/defaults: legacy and new signed record encodings are strictly distinct. */
export function decodeV2EnrollmentRecord(value: unknown) {
  return Schema.decodeUnknownSync(Schema.Union([V2EnrollmentRecord, V2LegacyEnrollmentRecord]))(
    value,
    { onExcessProperty: "error" },
  );
}
export const digestV2EnrollmentOwner = (owner: V2AnyEnrollmentOwner) =>
  owner.protocol === "bigbud.thread.v1"
    ? v2LegacyThreadOwnerDigest(owner)
    : v2ThreadOwnerDigest(owner);

/** Exact original nonce/domain, fresh cleanup auth, no authority to issue legacy enroll/renew. */
export function v2CleanupEnvelope(
  owner: V2AnyEnrollmentOwner,
  operation: "inspect" | "detach",
  privateKey: string,
) {
  const envelope = {
    protocol: owner.protocol,
    operation,
    issuer: owner.issuer,
    ownerDigest: digestV2EnrollmentOwner(owner),
    enrollmentNonce: owner.enrollmentNonce,
    requestId: randomBytes(16).toString("hex"),
    authExpiresAt: Date.now() + 14000,
    leaseRevision: null,
    leaseExpiresAt: null,
    owner: null,
  };
  return owner.protocol === "bigbud.thread.v1"
    ? signV2LegacyCleanup({ ...envelope, protocol: owner.protocol }, privateKey)
    : signV2ThreadEnvelope({ ...envelope, protocol: owner.protocol }, privateKey);
}
