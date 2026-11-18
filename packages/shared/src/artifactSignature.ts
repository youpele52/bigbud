import { createPublicKey, verify } from "node:crypto";

/** Verification only. The caller chooses pinned trust and owns canonical payload/domain encoding. */
export function verifyPinnedArtifactSignature(input: {
  readonly payload: Uint8Array;
  readonly publicKey: string;
  readonly signature: string;
  readonly strictEd25519?: boolean;
}): boolean {
  try {
    if (input.strictEd25519 && input.signature.length !== 88) return false;
    const key = createPublicKey(input.publicKey);
    const signature = Buffer.from(input.signature, "base64");
    if (
      input.strictEd25519 &&
      (key.asymmetricKeyType !== "ed25519" ||
        signature.length !== 64 ||
        signature.toString("base64") !== input.signature)
    )
      return false;
    return verify(null, input.payload, key, signature);
  } catch {
    return false;
  }
}
