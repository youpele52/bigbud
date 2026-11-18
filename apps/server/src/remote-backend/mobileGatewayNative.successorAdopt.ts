import { withMobilePublicationOwner } from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import { adoptNativeMobileGatewayAttempt } from "../remote-agent/mobileGatewayLifecycle.native.transitions.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import type { NativeMobileSuccessorCandidate } from "./mobileGatewayNative.restore.ts";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * After a verified successor Resume, durably record this instance as the attempt's current
 * controller through the held publication's canonical CAS journal, from exactly the foreign
 * controller the successor selected. Only then may owner admission (which requires the current
 * controller) admit the adopted original. A concurrent change refuses; nothing is guessed.
 */
export function adoptNativeMobileSuccessorController(
  proof: VerifiedMobilePublication,
  candidate: NativeMobileSuccessorCandidate,
  signal: AbortSignal,
): Promise<void> {
  const original = candidate.attempt.nativeOwnership;
  const from = candidate.attempt.currentController ?? candidate.attempt.controller;
  return withMobilePublicationOwner(
    proof,
    async ({ authority }, owned) => {
      const after = await authority
        .registry(AbortSignal.any([owned, signal]))
        .update((state) =>
          adoptNativeMobileGatewayAttempt(
            state,
            authority.pin,
            original,
            from,
            authority.controller,
          ),
        );
      const row =
        after.schemaVersion === 3 &&
        after.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === original.binding.nonce);
      if (!row || row.phase !== "attempted" || !equal(row.currentController, authority.controller))
        throw Error("Successor adoption CAS acknowledgement required.");
    },
    signal,
  );
}
