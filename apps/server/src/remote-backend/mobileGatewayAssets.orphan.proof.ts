import type { BigIntStats } from "node:fs";
import type { MobileGatewayAttempt } from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { mobileGatewayBuildPin } from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import {
  mobileRegistryOwnerEqual,
  type MobileRegistryOwner,
} from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { canonicalMobileAssetsReceipt } from "./mobileGatewayAssets.receipt.format.ts";
import type { MobileAssetsReceiptReference } from "./mobileGatewayAssets.receipt.reference.ts";
import type { MobileRuntimeRepairReason } from "./mobileGatewayAssets.orphan.reasons.ts";
import type {
  MobileAssetsDirectoryAnchor,
  MobileAssetsReceipt,
} from "./mobileGatewayAssets.receipt.schema.ts";

export type MobileRuntimeOrphanProof =
  | {
      readonly kind: "proven";
      readonly attempt: MobileGatewayAttempt;
      readonly reference: MobileAssetsReceiptReference;
    }
  | { readonly kind: "kept"; readonly reason: MobileRuntimeRepairReason };

const kept = (reason: MobileRuntimeRepairReason): MobileRuntimeOrphanProof => ({
  kind: "kept",
  reason,
});
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Stages whose publication or gateway attempt is still in flight. */
const IN_FLIGHT_STAGE_PHASES = new Set([
  "reserved",
  "artifact-bytes-verified",
  "publication-writing",
]);

/**
 * Canonical journal proof that a runtime generation is unowned: exactly one native attempt
 * recorded it, that attempt is `exit-confirmed`, its base pin is released, and neither an
 * unresolved attempt nor an in-flight publication is on the same (active) stage.
 */
export function mobileRuntimeOrphanProof(
  state: RemoteAgentRegistry,
  pin: MobileRegistryOwner,
  generation: string,
): MobileRuntimeOrphanProof {
  if (state.schemaVersion !== 3 || !mobileRegistryOwnerEqual(state.mobile.owner, pin))
    return kept("journal-owner-mismatch");
  const attempts = state.mobile.gatewayLifecycle?.attempts ?? [];
  const matching = attempts.filter(
    (a) => a.nativeOwnership?.assetsReference.generation === generation,
  );
  if (matching.length === 0) return kept("no-journal-attempt");
  if (matching.length > 1) return kept("ambiguous-journal");
  const attempt = matching[0]!;
  if (attempt.phase !== "exit-confirmed" || !attempt.nativeOwnership)
    return kept("attempt-not-exited");
  if (state.pins.some((p) => p.owner === mobileGatewayBuildPin(attempt.nonce)))
    return kept("pinned");
  const active = new Set([
    ...attempts.filter((a) => a.phase !== "exit-confirmed").map((a) => a.stageId),
    ...state.mobile.stages.filter((s) => IN_FLIGHT_STAGE_PHASES.has(s.phase)).map((s) => s.id),
  ]);
  if (active.has(attempt.stageId)) return kept("active-stage");
  return { kind: "proven", attempt, reference: attempt.nativeOwnership.assetsReference };
}

/** The receipt must canonically re-encode and name exactly the journal's attempt and owner. */
export function mobileRuntimeReceiptOwnership(
  bytes: Buffer,
  generation: string,
  attempt: MobileGatewayAttempt,
  pin: MobileRegistryOwner,
): { readonly receipt: MobileAssetsReceipt } | { readonly reason: MobileRuntimeRepairReason } {
  let receipt: MobileAssetsReceipt;
  try {
    const decoded = JSON.parse(bytes.toString("utf8")) as MobileAssetsReceipt;
    if (!canonicalMobileAssetsReceipt(decoded).equals(bytes)) return { reason: "receipt-mismatch" };
    receipt = decoded;
  } catch {
    return { reason: "receipt-mismatch" };
  }
  const uid = String(process.getuid?.() ?? -1);
  if (
    receipt.generation !== generation ||
    receipt.publication.preparationNonce !== attempt.nonce ||
    receipt.publication.stageId !== attempt.stageId ||
    receipt.publication.releaseId !== attempt.releaseId ||
    receipt.publication.consentRevision !== attempt.consentRevision ||
    !mobileRegistryOwnerEqual(receipt.owner, pin) ||
    !equal(
      { id: receipt.controller.id, pid: receipt.controller.pid, s: receipt.controller.startedAt },
      { id: attempt.controller.id, pid: attempt.controller.pid, s: attempt.controller.startedAt },
    ) ||
    (attempt.controllerHost !== undefined &&
      !equal(
        [receipt.controllerHost.hostname, receipt.controllerHost.machineId],
        [attempt.controllerHost.hostname, attempt.controllerHost.machineId],
      )) ||
    receipt.anchors.root.uid !== uid ||
    receipt.anchors.state.uid !== uid
  )
    return { reason: "ownership-mismatch" };
  return { receipt };
}

/** dev/inode/owner/mode of a live directory against the receipt's recorded anchor. */
export function mobileRuntimeAnchorMatches(
  info: BigIntStats,
  anchor: MobileAssetsDirectoryAnchor,
): boolean {
  return (
    info.isDirectory() &&
    info.dev.toString() === anchor.dev &&
    info.ino.toString() === anchor.ino &&
    info.uid.toString() === anchor.uid &&
    info.gid.toString() === anchor.gid &&
    info.mode.toString() === anchor.mode
  );
}
