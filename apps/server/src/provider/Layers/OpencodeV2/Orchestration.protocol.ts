import { createHash, sign } from "node:crypto";
import { Schema } from "effect";

export const V2_THREAD_RPC = "bigbud.thread.v1";
export const V2_ENROLLMENT_PROTOCOL = "bigbud.thread.enrollment.v2";
export const V2_THREAD_ACTIONS = [
  "create_thread",
  "send_thread_message",
  "get_thread_status",
  "list_threads",
  "rename_thread",
] as const;
export const V2_THREAD_OWNER_FIELDS = [
  "protocol",
  "issuer",
  "bootstrapDigest",
  "bootstrapAbi",
  "implementationDigest",
  "compatibilityDigest",
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
export const V2ThreadOwner = Schema.Struct({
  protocol: Schema.Literal(V2_ENROLLMENT_PROTOCOL),
  issuer: Hex,
  bootstrapDigest: Hex,
  bootstrapAbi: Bounded,
  implementationDigest: Hex,
  compatibilityDigest: Hex,
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
export type V2ThreadOwner = typeof V2ThreadOwner.Type;
export interface V2ThreadEnvelope {
  readonly protocol: typeof V2_ENROLLMENT_PROTOCOL;
  readonly operation: "enroll" | "renew" | "inspect" | "detach";
  readonly issuer: string;
  readonly ownerDigest: string;
  readonly enrollmentNonce: string;
  readonly requestId: string;
  readonly authExpiresAt: number;
  readonly leaseRevision: number | null;
  readonly leaseExpiresAt: number | null;
  readonly owner: V2ThreadOwner | null;
  readonly signature: string;
}

/** Lease/operation authentication never changes the durable owner identity. */
export function v2ThreadOwnerDigest(owner: V2ThreadOwner): string {
  return createHash("sha256")
    .update(JSON.stringify(V2_THREAD_OWNER_FIELDS.map((field) => owner[field])))
    .digest("hex");
}

/** Fixed-field encoding is shared with the dependency-free plugin renderer. */
export function v2ThreadEnvelopeBytes(envelope: Omit<V2ThreadEnvelope, "signature">): Buffer {
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
      envelope.owner ? V2_THREAD_OWNER_FIELDS.map((field) => envelope.owner![field]) : null,
    ]),
  );
}

/** Sign only app-issued identity and authentication; never accept a model-defined caller. */
export function signV2ThreadEnvelope(
  envelope: Omit<V2ThreadEnvelope, "signature">,
  privateKey: string,
): V2ThreadEnvelope {
  if (envelope.protocol !== V2_ENROLLMENT_PROTOCOL)
    throw new Error("V2 enrollment signing domain rejected.");
  return {
    ...envelope,
    signature: sign(null, v2ThreadEnvelopeBytes(envelope), privateKey).toString("base64url"),
  };
}
