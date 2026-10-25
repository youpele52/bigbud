import { createHash, sign } from "node:crypto";
import * as Schema from "effect/Schema";

/** Frozen v3 wire domain and field order. Never default legacy identities to a later owner encoding. */
export const V2_LEGACY_ENROLLMENT_PROTOCOL = "bigbud.thread.v1";
export const V2_LEGACY_OWNER_FIELDS = [
  "protocol",
  "issuer",
  "artifactDigest",
  "threadId",
  "nativeSessionId",
  "storageIdentity",
  "directory",
  "runtimeTargetId",
  "workspaceTargetId",
  "sessionEpoch",
  "transportGeneration",
  "consentRevision",
  "enrollmentNonce",
  "callbackUrl",
  "callbackToken",
] as const;
const Bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const V2LegacyThreadOwner = Schema.Struct({
  protocol: Schema.Literal(V2_LEGACY_ENROLLMENT_PROTOCOL),
  issuer: Hex,
  artifactDigest: Hex,
  threadId: Bounded,
  nativeSessionId: Bounded,
  storageIdentity: Bounded,
  directory: Bounded,
  runtimeTargetId: Schema.Literal("local"),
  workspaceTargetId: Schema.Literal("local"),
  sessionEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  transportGeneration: Bounded,
  consentRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  enrollmentNonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  callbackUrl: Bounded,
  callbackToken: Hex,
});
export type V2LegacyThreadOwner = typeof V2LegacyThreadOwner.Type;
export interface V2LegacyThreadEnvelope {
  readonly protocol: typeof V2_LEGACY_ENROLLMENT_PROTOCOL;
  readonly operation: "enroll" | "renew" | "inspect" | "detach";
  readonly issuer: string;
  readonly ownerDigest: string;
  readonly enrollmentNonce: string;
  readonly requestId: string;
  readonly authExpiresAt: number;
  readonly leaseRevision: number | null;
  readonly leaseExpiresAt: number | null;
  readonly owner: V2LegacyThreadOwner | null;
  readonly signature: string;
}

export function v2LegacyThreadOwnerDigest(owner: V2LegacyThreadOwner) {
  Schema.decodeUnknownSync(V2LegacyThreadOwner)(owner, { onExcessProperty: "error" });
  return createHash("sha256")
    .update(JSON.stringify(V2_LEGACY_OWNER_FIELDS.map((field) => owner[field])))
    .digest("hex");
}

export function v2LegacyThreadEnvelopeBytes(envelope: Omit<V2LegacyThreadEnvelope, "signature">) {
  return Buffer.from(
    JSON.stringify([
      envelope.protocol,
      envelope.operation,
      envelope.issuer,
      envelope.ownerDigest,
      envelope.enrollmentNonce,
      envelope.requestId,
      envelope.authExpiresAt,
      envelope.leaseRevision,
      envelope.leaseExpiresAt,
      envelope.owner ? V2_LEGACY_OWNER_FIELDS.map((field) => envelope.owner![field]) : null,
    ]),
  );
}

/** The new app may emit legacy authentication only for exact previous-owner inspect/detach cleanup. */
export function signV2LegacyCleanup(
  envelope: Omit<V2LegacyThreadEnvelope, "signature">,
  privateKey: string,
): V2LegacyThreadEnvelope {
  if (
    !["inspect", "detach"].includes(envelope.operation) ||
    envelope.owner !== null ||
    envelope.leaseRevision !== null ||
    envelope.leaseExpiresAt !== null ||
    envelope.protocol !== V2_LEGACY_ENROLLMENT_PROTOCOL
  )
    throw new Error(
      "V2 legacy authority is cleanup-only; no enrollment, renewal or reinterpretation.",
    );
  return {
    ...envelope,
    signature: sign(null, v2LegacyThreadEnvelopeBytes(envelope), privateKey).toString("base64url"),
  };
}
