/**
 * Server-side SHA-256 of the canonical policy bytes (node:crypto). Kept apart
 * from `policy.canonical` so browser code can encode without Node crypto.
 */
import { createHash } from "node:crypto";

import type {
  ComputerUsePolicyBody,
  ComputerUsePolicyGroup,
} from "@bigbud/contracts/core/settings.computerUsePolicy";

import { encodeCanonicalPolicy, type CanonicalPolicyRefusal } from "./policy.canonical";

export function policyDigestHex(canonical: Uint8Array): string {
  return createHash("sha256").update(canonical).digest("hex");
}

export type SealedPolicy =
  | { readonly ok: true; readonly group: ComputerUsePolicyGroup; readonly canonical: Uint8Array }
  | { readonly ok: false; readonly refusal: CanonicalPolicyRefusal | "digest_mismatch" };

/** Computes the digest for a complete body (writer side). */
export function sealPolicy(body: ComputerUsePolicyBody): SealedPolicy {
  const canonical = encodeCanonicalPolicy(body);
  if (!canonical.ok) return canonical;
  return {
    ok: true,
    group: { ...body, digest: policyDigestHex(canonical.bytes) },
    canonical: canonical.bytes,
  };
}

/** Recomputes and compares (reader side); a mismatch is never repaired. */
export function verifyPolicy(group: ComputerUsePolicyGroup): SealedPolicy {
  const { digest, ...body } = group;
  const sealed = sealPolicy(body);
  if (!sealed.ok) return sealed;
  return sealed.group.digest === digest
    ? { ok: true, group, canonical: sealed.canonical }
    : { ok: false, refusal: "digest_mismatch" };
}
