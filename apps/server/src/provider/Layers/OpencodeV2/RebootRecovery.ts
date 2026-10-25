import { V2ThreadRecords } from "./Orchestration.records.ts";
import path from "node:path";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";
import { decodeV2ThreadReceipt } from "./Orchestration.receipts.schema.ts";
import { readV2RecoveryHost, assertV2RebootBoundary } from "./RebootRecovery.host.ts";
import {
  checkpointKey,
  settlementKey,
  decodeCheckpoint,
  recoveryDigest,
} from "./RebootRecovery.schema.ts";
import {
  recoveryOwner,
  recoveryInventoryDigest,
  v2RecoveryJournalDigest,
  type V2RecoveryJournal,
} from "./RebootRecovery.evidence.ts";
import { readV2RebootCheckpoint, readV2RebootProof } from "./RebootRecovery.proof.ts";

type JournalReader = (threadId: string) => Promise<V2RecoveryJournal>;
export interface V2RebootPreparation {
  readonly enrollments: V2ThreadRecords;
  readonly issuer: string;
  readonly threadIds: readonly string[];
  readonly receiptNames: readonly string[];
  readonly backup: { directory: string; databaseDigest: string };
  readonly readJournal: JournalReader;
  readonly assertCurrent?: () => void;
}

/** Explicit maintenance preparation only; neither enrollment nor receipt evidence is mutated. */
export async function prepareV2RebootRecovery(input: V2RebootPreparation) {
  input.assertCurrent?.();
  const owners = await input.enrollments.inventory();
  if (!owners.length || owners.length > 64 || new Set(input.threadIds).size !== owners.length)
    throw new Error("V2 reboot preparation requires the exact bounded owner inventory.");
  const host = await readV2RecoveryHost(),
    journal = [];
  for (const entry of owners) {
    const { owner } = recoveryOwner(entry);
    if (owner.issuer !== input.issuer || !input.threadIds.includes(owner.threadId))
      throw new Error("V2 reboot preparation found an unrelated owner; none were changed.");
    journal.push({
      threadId: owner.threadId,
      digest: v2RecoveryJournalDigest(owner, await input.readJournal(owner.threadId)),
    });
  }
  if (new Set(journal.map((row) => row.threadId)).size !== owners.length)
    throw new Error("V2 reboot preparation requires unique exact owner identities.");
  const receipts = await (await input.enrollments.sibling("receipts")).inventory();
  if (
    receipts.length > 64 ||
    new Set(input.receiptNames).size !== receipts.length ||
    receipts.some((entry) => !input.receiptNames.includes(entry.name))
  )
    throw new Error(
      "V2 reboot preparation requires the exact explicitly selected receipt inventory.",
    );
  for (const entry of receipts) decodeV2ThreadReceipt(entry.signed.value);
  const store = await input.enrollments.sibling("recovery");
  if ((await store.inventory()).length)
    throw new Error("V2 reboot checkpoint already exists; it cannot be replaced.");
  const checkpoint = decodeCheckpoint({
    format: "bigbud.thread.reboot-checkpoint.v1",
    purpose: "physical-retirement-only-no-replay",
    stateRoot: path.dirname(input.enrollments.directory),
    issuer: input.issuer,
    preparedAt: new Date().toISOString(),
    host,
    backup: input.backup,
    owners,
    receipts,
    journal,
  });
  if (
    recoveryInventoryDigest(await input.enrollments.inventory()) !==
      recoveryInventoryDigest(owners) ||
    recoveryInventoryDigest(await (await input.enrollments.sibling("receipts")).inventory()) !==
      recoveryInventoryDigest(receipts)
  )
    throw new Error("V2 reboot preparation inventory changed; retry without altering originals.");
  const assertCurrent = input.assertCurrent ?? (() => {});
  assertCurrent();
  await store.replace(checkpointKey, undefined, checkpoint, {
    assertCurrent,
    signal: new AbortController().signal,
  });
  assertCurrent();
  return {
    directory: store.directory,
    checkpointDigest: recoveryDigest(await store.read(checkpointKey)),
    host,
    ownerCount: owners.length,
    receiptCount: receipts.length,
  };
}

export interface V2RebootApplication {
  readonly enrollments: V2ThreadRecords;
  readonly readJournal: JournalReader;
  /** Production caller holds the existing consent and closed activation gate across all writes. */
  readonly assertCurrent: () => void;
  readonly assertIdle: () => Promise<void>;
  readonly signal?: AbortSignal;
}

/** Staged retirements are unusable until one final signed group seal; interrupted attempts are retryable. */
export async function applyV2RebootRecovery(input: V2RebootApplication) {
  const prepared = await readV2RebootCheckpoint(input.enrollments);
  if (!prepared) return false;
  input.assertCurrent();
  if (await readV2RebootProof(input.enrollments)) return true;
  const host = await readV2RecoveryHost();
  assertV2RebootBoundary(prepared.checkpoint.host, host);
  const assertUnchanged = async () => {
    input.assertCurrent();
    if (
      recoveryInventoryDigest(await input.enrollments.inventory()) !==
        recoveryInventoryDigest(prepared.checkpoint.owners) ||
      recoveryInventoryDigest(await (await input.enrollments.sibling("receipts")).inventory()) !==
        recoveryInventoryDigest(prepared.checkpoint.receipts)
    )
      throw new Error("V2 reboot recovery ownership/receipt inventory changed; no retirement.");
    for (const entry of prepared.checkpoint.owners) {
      const { owner } = recoveryOwner(entry);
      const digest = v2RecoveryJournalDigest(owner, await input.readJournal(owner.threadId));
      if (
        prepared.checkpoint.journal.find((row) => row.threadId === owner.threadId)?.digest !==
        digest
      )
        throw new Error("V2 reboot recovery admission/creation evidence changed.");
    }
    await input.assertIdle();
    input.assertCurrent();
  };
  await assertUnchanged();
  const retirement = await V2EnrollmentRetirement.open(input.enrollments);
  const authority = {
    assertCurrent: input.assertCurrent,
    signal: input.signal ?? new AbortController().signal,
  };
  for (const entry of prepared.checkpoint.owners) {
    input.assertCurrent();
    const { owner, digest } = recoveryOwner(entry);
    await retirement.stageReboot(
      {
        wireProtocol: owner.protocol,
        ownerDigest: digest,
        enrollmentNonce: owner.enrollmentNonce,
        directory: owner.directory,
        nativeSessionId: owner.nativeSessionId,
      },
      entry.signed,
      prepared.digest,
      authority,
    );
  }
  await assertUnchanged();
  await prepared.store.replace(
    settlementKey,
    undefined,
    {
      format: "bigbud.thread.reboot-settlement.v1",
      checkpointDigest: prepared.digest,
      host,
      settledAt: new Date().toISOString(),
      physicalEvidence: "verified-host-reboot",
      receiptOutcome: "unknown-preserved-no-replay",
    },
    authority,
  );
  return true;
}
