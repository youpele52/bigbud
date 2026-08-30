import { createHash } from "node:crypto";

/** Produces the immutable authorization binding persisted with a finalize proof. */
export function directCleanupProofDigest(input: {
  readonly operationId: string;
  readonly payloadDigestVersion: string;
  readonly payloadDigest: string;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly eventType: string;
  readonly eventPayloadJson: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.operationId,
        input.payloadDigestVersion,
        input.payloadDigest,
        input.eventId,
        input.eventSequence,
        input.eventType,
        input.eventPayloadJson,
      ]),
    )
    .digest("hex");
}

/** Binds one immutable proof to the exact operation and page Rust may mutate. */
export function directCleanupAuthorizationDigest(input: {
  readonly operationId: string;
  readonly planDigest: string;
  readonly pageDigest: string;
  readonly proofDigest: string;
}): string {
  return createHash("sha256")
    .update(input.operationId)
    .update("\0")
    .update(Buffer.from(input.planDigest, "hex"))
    .update("\0")
    .update(Buffer.from(input.pageDigest, "hex"))
    .update("\0")
    .update(Buffer.from(input.proofDigest, "hex"))
    .digest("hex");
}
