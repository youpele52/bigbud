import { Schema } from "effect";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { nativeFamilyHash } from "./Subagents.protocol.ts";

export const V2_FAMILY_ABI = "opencode.native-family.v1";
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const V2FamilyEvidence = Schema.Struct({
  pendingBySession: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)),
  abi: Schema.Literal(V2_FAMILY_ABI),
  rootID: Id,
  ownerID: Id,
  generation: Schema.Int,
  stopped: Schema.Boolean,
  settled: Schema.Boolean,
  uncertain: Schema.Boolean,
  pending: Schema.Int,
});
export const V2FamilyReceipt = Schema.Struct({
  consumed: Schema.optionalKey(Schema.Boolean),
  abi: Schema.Literal(V2_FAMILY_ABI),
  rootID: Id,
  ownerID: Id,
  generation: Schema.Int,
  operationID: Id,
  parentID: Id,
  messageID: Id,
  callID: Id,
  childID: Id,
  notificationID: Id,
  jobGeneration: Schema.Number,
  status: Schema.Literals(["completed", "error", "cancelled"]),
});
export type V2FamilyReceipt = typeof V2FamilyReceipt.Type;

/** Decode only an authenticated native RPC result, never message metadata. */
export function decodeV2FamilyReceipt(
  value: unknown,
  owner: V2RuntimeSession,
  issuer: string,
  inputID: string,
) {
  const receipt = Schema.decodeUnknownSync(V2FamilyReceipt)(value, { onExcessProperty: "error" });
  const child = owner.family?.child(receipt.childID);
  if (
    receipt.rootID !== owner.native.id ||
    receipt.ownerID !== issuer ||
    receipt.generation !== owner.family?.generation ||
    receipt.notificationID !== inputID ||
    !child ||
    child.parentId !== receipt.parentID ||
    (child.generation ?? 0) !== receipt.generation ||
    ![child.executionReceipt, ...(child.executionReceipts ?? [])].includes(
      nativeFamilyHash([receipt.generation, receipt.parentID, receipt.messageID, receipt.callID]),
    )
  )
    throw new Error("V2 native receipt changed root/child/call/generation.");
  return receipt;
}
