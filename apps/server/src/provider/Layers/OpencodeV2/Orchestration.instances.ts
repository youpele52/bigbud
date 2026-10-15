import * as Schema from "effect/Schema";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import { decodeV2ThreadReceipt } from "./Orchestration.receipts.schema.ts";
import { recoveryDigest } from "./RebootRecovery.schema.ts";

/** The backend that holds the state-directory lock (structurally `BackendInstanceShape`). */
export interface V2BackendInstance {
  readonly nonce: string;
  readonly pid: number;
  readonly startedAt: string | null;
  readonly hostname: string;
  /** Stable machine identity (absent when the platform offers none); hostnames can change. */
  readonly machineId?: string | null;
  readonly stateDir: string;
  readonly assertHeld: () => Promise<void>;
  readonly classifyOwner: (owner: {
    readonly pid: number;
    readonly startedAt: string | null;
    readonly hostname: string;
    readonly machineId?: string | null | undefined;
  }) => "live" | "dead" | "foreign-host";
}

const Nonce = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const OwnerMarker = Schema.Struct({
  format: Schema.Literal("bigbud.thread.backend-owner.v1"),
  ownerDigest: Digest,
  enrollmentNonce: Nonce,
  backendInstance: Nonce,
  pid: Schema.Int,
  startedAt: Schema.NullOr(Schema.String),
  hostname: Schema.String,
  /** Absent in markers written before machine identity; then the hostname rule applies. */
  machineId: Schema.optionalKey(Schema.String),
});
export type V2OwnerMarker = typeof OwnerMarker.Type;
const ReceiptFence = Schema.Struct({
  format: Schema.Literal("bigbud.thread.receipt-fence.v1"),
  backendInstance: Nonce,
  receipts: Schema.Array(Schema.Struct({ name: Digest, digest: Digest })),
});

/** Reserved receipts that existed before this backend instance opened its broker: their handlers
 * ran in a provably dead process, so their outcome is unknown, preserved and never replayed. */
export interface V2ReceiptFence {
  readonly instance: string;
  readonly digest: string;
  readonly receipts: ReadonlyMap<string, string>;
}

const ownerKey = (ownerDigest: string) => JSON.stringify(["backend-owner", ownerDigest]);
const fenceKey = (nonce: string) => JSON.stringify(["receipt-fence", nonce]);
const strict = { onExcessProperty: "error" } as const;

/** Written before the enrollment record exists, so every new owner is attributable. */
export async function writeV2OwnerMarker(
  records: V2ThreadRecords,
  instance: Pick<V2BackendInstance, "nonce" | "pid" | "startedAt" | "hostname" | "machineId">,
  ownerDigest: string,
  enrollmentNonce: string,
) {
  const store = await records.sibling("instances");
  const value: V2OwnerMarker = {
    format: "bigbud.thread.backend-owner.v1",
    ownerDigest,
    enrollmentNonce,
    backendInstance: instance.nonce,
    pid: instance.pid,
    startedAt: instance.startedAt,
    hostname: instance.hostname,
    ...(instance.machineId ? { machineId: instance.machineId } : {}),
  };
  const existing = await store.read(ownerKey(ownerDigest));
  if (existing) {
    if (JSON.stringify(existing.value) !== JSON.stringify(value))
      throw new Error("V2 thread-tools owner attribution changed; evidence retained.");
    return;
  }
  await store.replace(ownerKey(ownerDigest), undefined, value);
}

/** Missing means the owner predates attribution (legacy) and is treated as foreign. */
export async function readV2OwnerMarker(records: V2ThreadRecords, ownerDigest: string) {
  const signed = await (await records.sibling("instances")).read(ownerKey(ownerDigest));
  if (!signed) return undefined;
  const marker = Schema.decodeUnknownSync(OwnerMarker)(signed.value, strict);
  if (marker.ownerDigest !== ownerDigest)
    throw new Error("V2 thread-tools owner attribution is invalid; evidence retained.");
  return marker;
}

function decodeFence(signed: { revision: string; value: unknown }, nonce: string): V2ReceiptFence {
  const fence = Schema.decodeUnknownSync(ReceiptFence)(signed.value, strict);
  if (fence.backendInstance !== nonce)
    throw new Error("V2 dead-backend receipt fence belongs to another backend instance.");
  return {
    instance: nonce,
    digest: recoveryDigest(signed),
    receipts: new Map(fence.receipts.map((entry) => [entry.name, entry.digest])),
  };
}

/** One fence per backend instance, taken before this instance can reserve any receipt; later
 * opens by the same instance reuse it and never widen it. */
export async function ensureV2ReceiptFence(
  records: V2ThreadRecords,
  instance: Pick<V2BackendInstance, "nonce">,
): Promise<V2ReceiptFence> {
  const store = await records.sibling("instances");
  const existing = await store.read(fenceKey(instance.nonce));
  if (existing) return decodeFence(existing, instance.nonce);
  const receipts: { name: string; digest: string }[] = [];
  for (const { name, signed } of await (await records.sibling("receipts")).inventory())
    if (decodeV2ThreadReceipt(signed.value).state === "reserved")
      receipts.push({ name, digest: recoveryDigest(signed) });
  try {
    await store.replace(fenceKey(instance.nonce), undefined, {
      format: "bigbud.thread.receipt-fence.v1",
      backendInstance: instance.nonce,
      receipts,
    });
  } catch (error) {
    const raced = await store.read(fenceKey(instance.nonce));
    if (!raced) throw error;
  }
  return decodeFence((await store.read(fenceKey(instance.nonce)))!, instance.nonce);
}

/** Exact signed fence named by a proof; a missing or changed fence is never evidence. */
export async function readV2ReceiptFence(records: V2ThreadRecords, nonce: string, digest: string) {
  const signed = await (await records.sibling("instances")).read(fenceKey(nonce));
  if (!signed || recoveryDigest(signed) !== digest)
    throw new Error("V2 dead-backend receipt fence evidence is missing or changed.");
  return decodeFence(signed, nonce);
}
