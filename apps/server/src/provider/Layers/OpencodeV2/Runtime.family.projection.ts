import type { SessionMessageInfo } from "@opencode/client";
import type { V2RuntimeSession } from "./Runtime.types.ts";

/** A native receipt, not child observation/metadata, authorizes each synthetic
 * continuation in the exact admitted root interval. Unproven inputs stay ambiguous. */
export async function readV2FamilyProjectionInputs(
  owner: V2RuntimeSession,
  messages: readonly SessionMessageInfo[],
  validate: () => void,
) {
  const result = new Set<string>();
  const receipt = owner.familyControl?.nativeReceipt;
  if (!receipt || owner.family?.isFenced || !owner.row) return result;
  const index = messages.findIndex(
    (message) =>
      message.id === owner.row!.nativeAdmissionId &&
      message.type === "user" &&
      message.metadata?.bigbud_fingerprint === owner.row!.fingerprint,
  );
  if (index < 0) return result;
  const generation = owner.family!.generation;
  for (const message of messages.slice(index + 1)) {
    if (message.type === "user") break;
    if (message.type !== "synthetic") continue;
    if (result.size >= 128) throw new Error("V2 native completion projection bound exceeded.");
    const proof = await receipt(message.id).catch(() => undefined);
    validate();
    owner.family!.assertSpawn(generation);
    if (!proof || proof.parentID !== owner.native.id) continue;
    await owner.family!.nativeCompletion(proof.childID, message.id);
    result.add(message.id);
  }
  return result;
}
