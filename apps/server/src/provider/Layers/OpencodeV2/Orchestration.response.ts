import { createHash, sign } from "node:crypto";

/** A bearer token authenticates the request, not a re-bound listener. Fresh response signatures prove app ownership. */
export function signV2ThreadCallbackResponse(
  input: {
    ownerDigest: string;
    enrollmentNonce: string;
    requestNonce: string;
    leaseRevision: number;
    leaseExpiresAt: number;
    kind: string;
  },
  result: unknown,
  privateKey: string,
  acknowledged = { revision: input.leaseRevision, expiry: input.leaseExpiresAt },
) {
  const encoded = JSON.stringify(result);
  if (encoded === undefined || Buffer.byteLength(encoded) > 90000)
    throw new Error("V2 callback result bound rejected.");
  const resultDigest = createHash("sha256").update(encoded).digest("hex");
  const requestDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return {
    ownerDigest: input.ownerDigest,
    enrollmentNonce: input.enrollmentNonce,
    requestNonce: input.requestNonce,
    leaseRevision: input.leaseRevision,
    leaseExpiresAt: input.leaseExpiresAt,
    acknowledgedRevision: acknowledged.revision,
    acknowledgedExpiry: acknowledged.expiry,
    operation: input.kind,
    requestDigest,
    result,
    signature: sign(
      null,
      Buffer.from(
        JSON.stringify([
          "callback-response",
          input.ownerDigest,
          input.enrollmentNonce,
          input.requestNonce,
          input.leaseRevision,
          input.leaseExpiresAt,
          acknowledged.revision,
          acknowledged.expiry,
          input.kind,
          requestDigest,
          resultDigest,
        ]),
      ),
      privateKey,
    ).toString("base64url"),
  };
}
