import { assertMobileGatewaySelectionTransition } from "./mobileGatewayActivation.selection.invariants.ts";
import { assertMobileGatewayLifecycleTransition } from "./mobileGatewayLifecycle.invariants.ts";
import { mobileRegistryOwnerEqual } from "./remoteAgentInstall.mobile.schema.ts";
import { assertMobileStageRetirementTransition } from "./mobileStageRetirement.rules.ts";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";

/** `beforeText` is captured before invoking caller code: it cannot share mutated references. */
export function assertMobileRegistryTransition(
  beforeText: string,
  next: RemoteAgentRegistry,
): void {
  const before = parseRemoteAgentRegistry(beforeText);
  if (before.schemaVersion !== 3) {
    if (
      next.schemaVersion === 3 &&
      (next.mobile.consent.revision !== 1 ||
        next.mobile.releases.length ||
        next.mobile.stages.length)
    ) {
      throw new Error("First mobile write must record separate consent before staging.");
    }
    return;
  }
  if (next.schemaVersion !== 3) throw new Error("Mobile registry v3 cannot be downgraded.");
  if (!mobileRegistryOwnerEqual(before.mobile.owner, next.mobile.owner)) {
    throw new Error("Immutable mobile authority or installation changed.");
  }
  assertMobileGatewayLifecycleTransition(before, next);
  assertMobileGatewaySelectionTransition(before.mobile, next.mobile);
  const advance = next.mobile.consent.revision - before.mobile.consent.revision;
  if (
    (advance !== 0 && advance !== 1) ||
    (before.mobile.consent.enabled !== next.mobile.consent.enabled && advance !== 1)
  ) {
    throw new Error("Mobile consent revision must advance monotonically when consent changes.");
  }
  // Only provably unused stages of superseded consent may leave (see mobileStageRetirement).
  assertMobileStageRetirementTransition(before.mobile, before.pins, next.mobile);
  for (const prior of before.mobile.stages) {
    const stage = next.mobile.stages.find((entry) => entry.id === prior.id);
    if (!stage) continue;
    if (
      stage.releaseId !== prior.releaseId ||
      stage.consentRevision !== prior.consentRevision ||
      stage.controller.id !== prior.controller.id ||
      stage.controller.pid !== prior.controller.pid ||
      stage.controller.startedAt !== prior.controller.startedAt ||
      JSON.stringify(stage.controllerHost) !== JSON.stringify(prior.controllerHost) ||
      (prior.phase === "cancelled" && JSON.stringify(stage) !== JSON.stringify(prior)) ||
      {
        reserved: 0,
        "artifact-bytes-verified": 1,
        "publication-writing": 2,
        "files-published": 3,
        cancelled: 4,
      }[stage.phase] <
        {
          reserved: 0,
          "artifact-bytes-verified": 1,
          "publication-writing": 2,
          "files-published": 3,
          cancelled: 4,
        }[prior.phase] ||
      (prior.publicationIntent &&
        JSON.stringify(prior.publicationIntent) !== JSON.stringify(stage.publicationIntent)) ||
      (prior.publicationReceipt &&
        JSON.stringify(prior.publicationReceipt) !== JSON.stringify(stage.publicationReceipt))
    ) {
      throw new Error("Mobile stage identity or terminal phase changed.");
    }
  }
}
