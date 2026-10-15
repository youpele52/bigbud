import * as Schema from "effect/Schema";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import { readV2ReceiptFence } from "./Orchestration.instances.ts";
import { v2ReceiptRetirementEvidence } from "./Orchestration.receipts.fence.ts";
import { readV2RebootProof } from "./RebootRecovery.proof.ts";

export const V2_DEAD_BACKEND_PROOF = "bigbud.thread.retirement-proof.owner-backend-dead.v1";

const Nonce = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const FenceReference = Schema.Struct({ instance: Nonce, digest: Digest });
export type V2ReceiptFenceReference = typeof FenceReference.Type;

/** Versioned, distinct proof kind: the owner's backend is provably dead (this process holds the
 * state-directory lock, the owner is attributed to another or no instance) and the exact native
 * session was inactive. Older builds' exact-key validator rejects it, so they fail closed. */
const DeadBackendProof = Schema.Struct({
  kind: Schema.Literal(V2_DEAD_BACKEND_PROOF),
  settlingBackendInstance: Nonce,
  settlingPid: Schema.Int,
  ownerBackendInstance: Schema.NullOr(Nonce),
  nativeInactiveObservedAt: Schema.String,
  receiptFence: FenceReference,
  receiptsSettled: Schema.Boolean,
});
export type V2DeadBackendRetirementProof = typeof DeadBackendProof.Type;

/** Live proof whose unknown receipt outcomes are fenced by a dead-backend fence (Q1). The five
 * physical flags stay mandatory; only fenced reserved receipts may leave receiptsSettled false. */
const FencedLiveProof = Schema.Struct({
  physicalSettled: Schema.Literal(true),
  controlsSettled: Schema.Literal(true),
  callbacksSettled: Schema.Literal(true),
  creationSettled: Schema.Literal(true),
  admissionsSettled: Schema.Literal(true),
  receiptsSettled: Schema.Literal(false),
  rebootReceiptCheckpointDigest: Schema.optional(Digest),
  deadBackendReceiptFence: FenceReference,
});

const strictly =
  (decode: (value: unknown, options: { onExcessProperty: "error" }) => unknown) =>
  (value: unknown) => {
    try {
      decode(value, { onExcessProperty: "error" });
      return true;
    } catch {
      return false;
    }
  };
const isDeadBackendShape = strictly(Schema.decodeUnknownSync(DeadBackendProof));

export const provedDeadBackend = (value: unknown): value is V2DeadBackendRetirementProof =>
  isDeadBackendShape(value) &&
  (value as V2DeadBackendRetirementProof).receiptFence.instance ===
    (value as V2DeadBackendRetirementProof).settlingBackendInstance;

export const provedFencedLive = strictly(Schema.decodeUnknownSync(FencedLiveProof));

/** Fence-bearing proofs name exact signed evidence. At settlement the live proof's coverage is
 * recomputed against that fence; afterwards the fence and reboot seal digests are re-verified
 * (fenced receipts belong to dead processes and cannot change outcome). */
export async function verifyV2FencedReceiptProof(
  records: V2ThreadRecords,
  proof: unknown,
  mode: "settle" | "read",
) {
  if (provedDeadBackend(proof)) {
    await readV2ReceiptFence(records, proof.receiptFence.instance, proof.receiptFence.digest);
    return;
  }
  const live = proof as {
    rebootReceiptCheckpointDigest?: string;
    deadBackendReceiptFence: V2ReceiptFenceReference;
  };
  const fence = await readV2ReceiptFence(
    records,
    live.deadBackendReceiptFence.instance,
    live.deadBackendReceiptFence.digest,
  );
  const receipts = await records.sibling("receipts");
  if (mode === "settle") {
    const current = await v2ReceiptRetirementEvidence(receipts, fence);
    if (
      current.receiptsSettled ||
      JSON.stringify(current.deadBackendReceiptFence) !==
        JSON.stringify(live.deadBackendReceiptFence) ||
      current.rebootReceiptCheckpointDigest !== live.rebootReceiptCheckpointDigest
    )
      throw new Error("V2 retirement requires exact fenced unknown receipt evidence.");
    return;
  }
  if (
    live.rebootReceiptCheckpointDigest &&
    (await readV2RebootProof(receipts))?.digest !== live.rebootReceiptCheckpointDigest
  )
    throw new Error("V2 retirement requires exact reboot-fenced unknown receipt evidence.");
}
