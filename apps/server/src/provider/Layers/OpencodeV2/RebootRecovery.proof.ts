import { v2ThreadPrivateDirectory } from "./Orchestration.storage.ts";
import path from "node:path";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import type { V2RetirementIdentity } from "./Orchestration.enrollment.retirement.ts";
import { recoveryOwner } from "./RebootRecovery.evidence.ts";
import { decodeV2EnrollmentRecord } from "./Orchestration.enrollment.record.ts";
import { decodeV2ThreadReceipt } from "./Orchestration.receipts.schema.ts";
import {
  readV2RecoveryHost,
  assertV2RebootBoundary,
  assertV2RecoveryContinuation,
} from "./RebootRecovery.host.ts";
import {
  checkpointKey,
  settlementKey,
  decodeCheckpoint,
  decodeSettlement,
  recoveryDigest,
} from "./RebootRecovery.schema.ts";

/** Optional inspection does not create a recovery namespace on ordinary installations. */
export async function readV2RebootCheckpoint(records: V2ThreadRecords) {
  try {
    await v2ThreadPrivateDirectory(path.join(path.dirname(records.directory), "recovery"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const store = await records.sibling("recovery"),
    signed = await store.read(checkpointKey);
  if (!signed) throw new Error("V2 reboot recovery checkpoint is incomplete; retain evidence.");
  const checkpoint = decodeCheckpoint(signed.value);
  if (checkpoint.stateRoot !== path.dirname(records.directory))
    throw new Error("V2 reboot recovery state root changed.");
  for (const entry of checkpoint.owners)
    if (recoveryOwner(entry).owner.issuer !== checkpoint.issuer)
      throw new Error("V2 reboot recovery issuer changed.");
  return { store, checkpoint, digest: recoveryDigest(signed) };
}

/** A signed pointer alone is not retirement: the final group seal and genuine OS boundary are mandatory. */
export async function readV2RebootProof(records: V2ThreadRecords) {
  const prepared = await readV2RebootCheckpoint(records);
  if (!prepared) return undefined;
  const signed = await prepared.store.read(settlementKey);
  if (!signed) return undefined;
  const seal = decodeSettlement(signed.value),
    current = await readV2RecoveryHost();
  if (seal.checkpointDigest !== prepared.digest)
    throw new Error("V2 reboot recovery seal/host changed.");
  assertV2RecoveryContinuation(seal.host, current);
  assertV2RebootBoundary(prepared.checkpoint.host, seal.host);
  return { ...prepared, seal };
}

export async function assertV2RebootRetirement(
  records: V2ThreadRecords,
  identity: V2RetirementIdentity,
  checkpointDigest: string,
  archive: unknown,
) {
  const proof = await readV2RebootProof(records);
  const entry = proof?.checkpoint.owners.find((candidate) => {
    const { owner, digest } = recoveryOwner(candidate);
    return (
      identity.wireProtocol === owner.protocol &&
      identity.ownerDigest === digest &&
      identity.enrollmentNonce === owner.enrollmentNonce &&
      identity.directory === owner.directory &&
      identity.nativeSessionId === owner.nativeSessionId
    );
  });
  if (
    !proof ||
    proof.digest !== checkpointDigest ||
    !entry ||
    recoveryDigest(entry.signed) !== recoveryDigest(archive)
  )
    throw new Error("V2 reboot retirement has no exact sealed checkpoint evidence.");
  const { owner, digest } = recoveryOwner(entry);
  const current = await (
    await records.sibling("enrollments")
  ).read(JSON.stringify([owner.storageIdentity, owner.nativeSessionId, owner.threadId]));
  if (
    current &&
    decodeV2EnrollmentRecord(current.value).digest === digest &&
    recoveryDigest(current) !== recoveryDigest(entry.signed)
  )
    throw new Error("V2 reboot retirement owner was resurrected or its signed record changed.");
}

export async function v2RebootReceiptEvidence(records: V2ThreadRecords) {
  const proof = await readV2RebootProof(records);
  const retired = new Map(
    proof?.checkpoint.receipts.map((entry) => [entry.name, recoveryDigest(entry.signed)]) ?? [],
  );
  let uncertain = 0,
    unfenced = 0;
  for (const { name, signed } of await records.inventory()) {
    if (decodeV2ThreadReceipt(signed.value).state !== "reserved") continue;
    uncertain++;
    if (retired.get(name) !== recoveryDigest(signed)) unfenced++;
  }
  return {
    receiptsSettled: uncertain === 0,
    ...(uncertain > 0 && unfenced === 0 && proof
      ? { rebootReceiptCheckpointDigest: proof.digest }
      : {}),
  };
}
