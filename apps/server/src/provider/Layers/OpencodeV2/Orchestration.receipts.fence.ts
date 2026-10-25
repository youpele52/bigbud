import type { V2ThreadRecords } from "./Orchestration.records.ts";
import type { V2ReceiptFence } from "./Orchestration.instances.ts";
import { decodeV2ThreadReceipt } from "./Orchestration.receipts.schema.ts";
import { readV2RebootProof, v2RebootReceiptEvidence } from "./RebootRecovery.proof.ts";
import { recoveryDigest } from "./RebootRecovery.schema.ts";

/** Live retirement receipt evidence (decision Q1, 2026-10-15). A reserved receipt fenced by the
 * sealed reboot checkpoint or by this backend instance's dead-backend fence belongs to a provably
 * dead process: its outcome is unknown, preserved and never replayed, so it no longer blocks live
 * settlement. Any other reserved receipt (reserved by this live instance) still blocks exactly as
 * before. Without a fence this is exactly the reboot-only evidence. */
export async function v2ReceiptRetirementEvidence(
  receipts: V2ThreadRecords,
  fence?: V2ReceiptFence,
): Promise<{
  receiptsSettled: boolean;
  rebootReceiptCheckpointDigest?: string;
  deadBackendReceiptFence?: { instance: string; digest: string };
}> {
  if (!fence) return v2RebootReceiptEvidence(receipts);
  const proof = await readV2RebootProof(receipts);
  const rebooted = new Map(
    proof?.checkpoint.receipts.map((entry) => [entry.name, recoveryDigest(entry.signed)]) ?? [],
  );
  let uncertain = 0,
    unfenced = 0,
    viaReboot = false,
    viaFence = false;
  for (const { name, signed } of await receipts.inventory()) {
    if (decodeV2ThreadReceipt(signed.value).state !== "reserved") continue;
    uncertain++;
    const digest = recoveryDigest(signed);
    if (proof && rebooted.get(name) === digest) viaReboot = true;
    else if (fence.receipts.get(name) === digest) viaFence = true;
    else unfenced++;
  }
  const fenced = uncertain > 0 && unfenced === 0;
  return {
    receiptsSettled: uncertain === 0,
    ...(fenced && viaReboot && proof ? { rebootReceiptCheckpointDigest: proof.digest } : {}),
    ...(fenced && viaFence
      ? { deadBackendReceiptFence: { instance: fence.instance, digest: fence.digest } }
      : {}),
  };
}
