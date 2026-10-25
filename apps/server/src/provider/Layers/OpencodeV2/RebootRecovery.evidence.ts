import { recoveryDigest } from "./RebootRecovery.schema.ts";
import * as Schema from "effect/Schema";
import { ProviderTurnAdmissionBinding } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import {
  decodeV2EnrollmentRecord,
  digestV2EnrollmentOwner,
} from "./Orchestration.enrollment.record.ts";
import type { V2ThreadRecords } from "./Orchestration.records.ts";

export const recoveryAdmissionQuery = `SELECT namespace, owner_thread_id, request_message_id,
  binding_json, fingerprint, native_admission_id, turn_id, state, revision, terminal_outcome
  FROM provider_turn_admissions WHERE owner_thread_id = ?
  ORDER BY namespace, request_message_id LIMIT 65`;
export const recoveryBindingQuery = `SELECT material_json, state, revision
  FROM opencode_v2_shared_bindings WHERE thread_id = ?`;
export interface V2RecoveryJournal {
  readonly admissions: readonly Record<string, unknown>[];
  readonly bindings: readonly Record<string, unknown>[];
}

/** Only exact verified creation and terminal admissions qualify; no text/result data is needed. */
export function v2RecoveryJournalDigest(
  owner: ReturnType<typeof decodeV2EnrollmentRecord>["owner"],
  evidence: V2RecoveryJournal,
) {
  if (
    !evidence.admissions.length ||
    evidence.admissions.length > 64 ||
    evidence.bindings.length !== 1
  )
    throw new Error("V2 reboot recovery journal is absent or exceeds its bound.");
  const binding = evidence.bindings[0]!;
  const material = JSON.parse(String(binding.material_json));
  if (
    binding.state !== "verified" ||
    material.threadId !== owner.threadId ||
    material.nativeSessionId !== owner.nativeSessionId ||
    material.storageIdentity !== owner.storageIdentity ||
    material.directory !== owner.directory ||
    material.runtimeTargetId !== owner.runtimeTargetId ||
    material.workspaceTargetId !== owner.workspaceTargetId
  )
    throw new Error("V2 reboot recovery creation is not exactly verified.");
  for (const row of evidence.admissions) {
    const value = Schema.decodeUnknownSync(ProviderTurnAdmissionBinding)(
      JSON.parse(String(row.binding_json)),
      { onExcessProperty: "error" },
    );
    if (
      row.state !== "terminal" ||
      row.owner_thread_id !== owner.threadId ||
      !["completed", "failed", "interrupted"].includes(String(row.terminal_outcome)) ||
      value.provider !== "opencodeV2" ||
      value.threadId !== owner.threadId ||
      value.nativeSessionId !== owner.nativeSessionId ||
      value.storageIdentity !== owner.storageIdentity ||
      value.location !== owner.directory ||
      value.runtimeTargetId !== owner.runtimeTargetId ||
      value.workspaceTargetId !== owner.workspaceTargetId
    )
      throw new Error("V2 reboot recovery admission remains unresolved or its identity changed.");
  }
  return recoveryDigest(evidence);
}

export function recoveryOwner(entry: Awaited<ReturnType<V2ThreadRecords["inventory"]>>[number]) {
  const record = decodeV2EnrollmentRecord(entry.signed.value);
  const owner = record.owner;
  if (
    owner.protocol !== "bigbud.thread.v1" ||
    record.digest !== digestV2EnrollmentOwner(owner) ||
    record.pending !== null ||
    !record.acknowledged ||
    entry.name !== recoveryDigest([owner.storageIdentity, owner.nativeSessionId, owner.threadId])
  ) {
    throw new Error(
      "V2 reboot recovery requires an exact acknowledged legacy owner without pending controls.",
    );
  }
  return record;
}

export function recoveryInventoryDigest(
  entries: Awaited<ReturnType<V2ThreadRecords["inventory"]>>,
) {
  return recoveryDigest(entries.toSorted((a, b) => a.name.localeCompare(b.name)));
}
